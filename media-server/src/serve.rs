// SPDX-License-Identifier: Apache-2.0
//! The HTTP side: token and Host checks, routing, Range-aware file
//! serving for `/media` (docs/media-server-spec.md §4-§5, Phase 2), and
//! ffprobe-based facts plus an informational verdict for `/meta`
//! (video/audio only, Phase 3 — see the plan). Neither route does any
//! conversion; there is still no queue.

use std::convert::Infallible;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::{Request, Response, StatusCode};

use crate::Handles;

#[derive(Clone)]
pub struct Context {
    pub port: u16,
    pub token: String,
    pub handles: Handles,
    pub backends: media_core::Backends,
    pub capabilities: media_core::Capabilities,
    pub probe_cache: media_core::ProbeCache,
}

type Res = Response<Full<Bytes>>;

fn text(status: StatusCode, body: &str) -> Res {
    Response::builder()
        .status(status)
        .body(Full::new(Bytes::copy_from_slice(body.as_bytes())))
        .unwrap()
}

fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then_some(v)
    })
}

fn authorized(req: &Request<Incoming>, ctx: &Context) -> bool {
    let header_ok = req
        .headers()
        .get(hyper::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == format!("Bearer {}", ctx.token));
    if header_ok {
        return true;
    }
    // `<img>`/`<video>` can't set a header, so the token also travels as
    // a query param (spec §4).
    query_param(req.uri().query().unwrap_or(""), "t").is_some_and(|t| t == ctx.token)
}

/// Rejects anything whose `Host` isn't exactly `127.0.0.1:<port>` — a
/// DNS-rebinding defense (spec §10). The frontend always builds URLs
/// with the literal `127.0.0.1`, never `localhost`, so this is never a
/// false rejection of a legitimate request.
fn host_ok(req: &Request<Incoming>, ctx: &Context) -> bool {
    let expected = format!("127.0.0.1:{}", ctx.port);
    req.headers()
        .get(hyper::header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|h| h == expected)
}

/// Reflects the request's own `Origin` back as `Access-Control-Allow-
/// Origin`, so `fetch("/meta", ...)` works from the webview — whose
/// origin is `http://localhost:5173` in `tauri dev` but the app's own
/// custom-protocol origin in a production build, so no single hardcoded
/// value covers both. Safe to reflect unconditionally here because the
/// token and `Host` checks above are the real access control; CORS is
/// only ever in the way of a browser's *own* page reading a response it
/// already received, not a way to reach this server from elsewhere —
/// a request without the right token never gets this far regardless of
/// its `Origin`.
fn with_cors(mut res: Res, origin: Option<&str>) -> Res {
    if let Some(origin) = origin {
        if let Ok(value) = hyper::header::HeaderValue::from_str(origin) {
            res.headers_mut().insert(hyper::header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
        }
    }
    res
}

pub async fn handle(req: Request<Incoming>, ctx: Context) -> Result<Res, Infallible> {
    let origin = req
        .headers()
        .get(hyper::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let res = handle_inner(req, &ctx).await;
    Ok(with_cors(res, origin.as_deref()))
}

async fn handle_inner(req: Request<Incoming>, ctx: &Context) -> Res {
    if !host_ok(&req, ctx) {
        return text(StatusCode::FORBIDDEN, "wrong host");
    }
    if !authorized(&req, ctx) {
        return text(StatusCode::FORBIDDEN, "missing or wrong token");
    }
    let route = req.uri().path().to_string();
    let Some(handle) = query_param(req.uri().query().unwrap_or(""), "h") else {
        return text(StatusCode::BAD_REQUEST, "missing h");
    };
    let Some(path) = ctx.handles.resolve(handle) else {
        return text(StatusCode::NOT_FOUND, "unknown or stale handle");
    };
    match route.as_str() {
        "/media" => {
            let range_header = req
                .headers()
                .get(hyper::header::RANGE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            serve_file(Path::new(&path), range_header.as_deref())
        }
        "/meta" => serve_meta(ctx, Path::new(&path)),
        _ => text(StatusCode::NOT_FOUND, "no such route"),
    }
}

fn json(status: StatusCode, body: &serde_json::Value) -> Res {
    Response::builder()
        .status(status)
        .header(hyper::header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap()
}

/// ffprobe-based facts and an informational verdict for the file a
/// handle resolves to. Video/audio only (Phase 3's scope) — a still
/// image handle probes fine as "nothing ffprobe could identify" and
/// comes back `Unsupported`, which is an honest, if uninformative,
/// answer until Phase 5's still pipeline exists.
fn serve_meta(ctx: &Context, path: &Path) -> Res {
    let Some(ffprobe) = ctx.backends.get("ffprobe") else {
        return json(StatusCode::SERVICE_UNAVAILABLE, &serde_json::json!({
            "error": "ffprobe is not configured — see Settings \u{2192} Backends",
        }));
    };
    match ctx.probe_cache.probe(&ffprobe, path) {
        Ok(result) => {
            let verdict = media_core::classify(&result, &ctx.capabilities, &ctx.backends);
            json(StatusCode::OK, &serde_json::json!({ "probe": result, "verdict": verdict }))
        }
        Err(e) => json(StatusCode::UNPROCESSABLE_ENTITY, &serde_json::json!({ "error": e })),
    }
}

fn mime_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

#[derive(Debug, PartialEq, Eq)]
enum RangeOutcome {
    /// No usable `Range` header: absent, malformed, or a multi-range
    /// request (not supported — nothing this app plays ever sends
    /// one). The correct HTTP answer to an unparseable Range is to
    /// ignore it, not to error.
    Full,
    Range(u64, u64),
    /// Parsed fine, but names bytes the file doesn't have.
    Unsatisfiable,
}

/// `Range: bytes=START-END` or `bytes=START-`, against a file of `len`
/// bytes.
fn parse_range(header: &str, len: u64) -> RangeOutcome {
    let Some(spec) = header.strip_prefix("bytes=") else {
        return RangeOutcome::Full;
    };
    if spec.contains(',') {
        return RangeOutcome::Full;
    }
    let Some((start_s, end_s)) = spec.split_once('-') else {
        return RangeOutcome::Full;
    };
    let Ok(start) = start_s.parse::<u64>() else {
        return RangeOutcome::Full;
    };
    if start >= len {
        return RangeOutcome::Unsatisfiable;
    }
    let end = if end_s.is_empty() {
        len - 1
    } else {
        match end_s.parse::<u64>() {
            Ok(e) => e.min(len.saturating_sub(1)),
            Err(_) => return RangeOutcome::Full,
        }
    };
    if start > end {
        return RangeOutcome::Unsatisfiable;
    }
    RangeOutcome::Range(start, end)
}

fn serve_file(path: &Path, range_header: Option<&str>) -> Res {
    let Ok(mut file) = File::open(path) else {
        return text(StatusCode::NOT_FOUND, "the file is not there any more");
    };
    let Ok(meta) = file.metadata() else {
        return text(StatusCode::NOT_FOUND, "could not read the file");
    };
    let len = meta.len();
    let mime = mime_for(path);

    let outcome = range_header.map_or(RangeOutcome::Full, |h| parse_range(h, len));

    match outcome {
        RangeOutcome::Unsatisfiable => Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(hyper::header::CONTENT_RANGE, format!("bytes */{len}"))
            .body(Full::new(Bytes::new()))
            .unwrap(),
        RangeOutcome::Range(start, end) => {
            let count = (end - start + 1) as usize;
            if file.seek(SeekFrom::Start(start)).is_err() {
                return text(StatusCode::INTERNAL_SERVER_ERROR, "seek failed");
            }
            let mut buf = vec![0u8; count];
            if file.read_exact(&mut buf).is_err() {
                return text(StatusCode::INTERNAL_SERVER_ERROR, "read failed");
            }
            Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(hyper::header::CONTENT_TYPE, mime)
                .header(hyper::header::ACCEPT_RANGES, "bytes")
                .header(hyper::header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .header(hyper::header::CONTENT_LENGTH, count.to_string())
                .body(Full::new(Bytes::from(buf)))
                .unwrap()
        }
        RangeOutcome::Full => {
            let mut buf = Vec::with_capacity(len as usize);
            if file.read_to_end(&mut buf).is_err() {
                return text(StatusCode::INTERNAL_SERVER_ERROR, "read failed");
            }
            Response::builder()
                .status(StatusCode::OK)
                .header(hyper::header::CONTENT_TYPE, mime)
                .header(hyper::header::ACCEPT_RANGES, "bytes")
                .header(hyper::header::CONTENT_LENGTH, buf.len().to_string())
                .body(Full::new(Bytes::from(buf)))
                .unwrap()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_valid_range_is_satisfiable() {
        assert_eq!(parse_range("bytes=0-", 10), RangeOutcome::Range(0, 9));
    }

    /// The "no `Range` header at all" case lives one level up, in
    /// `serve_file`'s `range_header.map_or(Full, ...)` — nothing to
    /// parse, so nothing for `parse_range` itself to cover. See
    /// `serving_without_a_range_header_returns_the_whole_file` below.
    #[test]
    fn open_ended_range_runs_to_the_end() {
        assert_eq!(parse_range("bytes=10-", 100), RangeOutcome::Range(10, 99));
    }

    #[test]
    fn closed_range_is_clamped_to_the_file() {
        assert_eq!(parse_range("bytes=10-50", 20), RangeOutcome::Range(10, 19));
    }

    #[test]
    fn start_past_the_end_is_unsatisfiable() {
        assert_eq!(parse_range("bytes=500-600", 100), RangeOutcome::Unsatisfiable);
    }

    #[test]
    fn backwards_range_is_unsatisfiable() {
        assert_eq!(parse_range("bytes=50-10", 100), RangeOutcome::Unsatisfiable);
    }

    #[test]
    fn multi_range_falls_back_to_full() {
        assert_eq!(parse_range("bytes=0-10,20-30", 100), RangeOutcome::Full);
    }

    #[test]
    fn garbage_falls_back_to_full() {
        assert_eq!(parse_range("not a range", 100), RangeOutcome::Full);
        assert_eq!(parse_range("bytes=abc-def", 100), RangeOutcome::Full);
    }

    #[test]
    fn mime_types_cover_the_native_tiers() {
        assert_eq!(mime_for(Path::new("a.PNG")), "image/png");
        assert_eq!(mime_for(Path::new("a.mp4")), "video/mp4");
        assert_eq!(mime_for(Path::new("a.flac")), "audio/flac");
        assert_eq!(mime_for(Path::new("a.exr")), "application/octet-stream");
    }

    struct TempFile {
        path: std::path::PathBuf,
    }

    impl TempFile {
        fn with_bytes(name: &str, bytes: &[u8]) -> Self {
            let path = std::env::temp_dir()
                .join(format!("media-server-test-{}-{name}", std::process::id()));
            std::fs::write(&path, bytes).unwrap();
            TempFile { path }
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    async fn body_bytes(res: Res) -> Vec<u8> {
        use http_body_util::BodyExt;
        res.into_body().collect().await.unwrap().to_bytes().to_vec()
    }

    #[tokio::test]
    async fn serving_without_a_range_header_returns_the_whole_file() {
        let data = b"hello world";
        let file = TempFile::with_bytes("full.bin", data);
        let res = serve_file(&file.path, None);
        assert_eq!(res.status(), StatusCode::OK);
        let content_length = res.headers().get(hyper::header::CONTENT_LENGTH).unwrap().clone();
        assert_eq!(body_bytes(res).await, data);
        assert_eq!(content_length, "11");
    }

    #[tokio::test]
    async fn serving_a_valid_range_returns_206_with_just_that_slice() {
        let data = b"hello world";
        let file = TempFile::with_bytes("ranged.bin", data);
        let res = serve_file(&file.path, Some("bytes=6-10"));
        assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
        let content_range = res.headers().get(hyper::header::CONTENT_RANGE).unwrap().clone();
        assert_eq!(body_bytes(res).await, b"world");
        assert_eq!(content_range, "bytes 6-10/11");
    }

    #[test]
    fn serving_an_out_of_bounds_range_is_416() {
        let data = b"hello world";
        let file = TempFile::with_bytes("oob.bin", data);
        let res = serve_file(&file.path, Some("bytes=1000-2000"));
        assert_eq!(res.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    }

    #[test]
    fn serving_a_missing_file_is_404() {
        let missing = std::env::temp_dir().join("media-server-test-definitely-missing.bin");
        let res = serve_file(&missing, None);
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    fn test_ctx(backends: media_core::Backends) -> Context {
        Context {
            port: 0,
            token: "tok".to_string(),
            handles: Handles::default(),
            backends,
            capabilities: media_core::Capabilities::default(),
            probe_cache: media_core::ProbeCache::default(),
        }
    }

    #[test]
    fn with_cors_reflects_the_request_origin() {
        let res = with_cors(text(StatusCode::OK, "ok"), Some("http://localhost:5173"));
        assert_eq!(
            res.headers().get(hyper::header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
            "http://localhost:5173"
        );
    }

    #[test]
    fn with_cors_adds_nothing_without_an_origin_header() {
        let res = with_cors(text(StatusCode::OK, "ok"), None);
        assert!(res.headers().get(hyper::header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
    }

    #[tokio::test]
    async fn meta_with_no_ffprobe_configured_is_503() {
        let ctx = test_ctx(media_core::Backends::default());
        let res = serve_meta(&ctx, Path::new("whatever.mp4"));
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = String::from_utf8(body_bytes(res).await).unwrap();
        assert!(body.contains("ffprobe"), "body was: {body}");
    }

    /// Exercises the real `ffprobe` on this machine, end to end:
    /// generate a tiny real video with `ffmpeg`, probe it, classify it.
    /// Ignored by default (CI has none of these tools) — run with
    /// `cargo test -p media-server -- --ignored`.
    #[tokio::test]
    #[ignore = "depends on this machine's installed backends"]
    async fn meta_probes_a_real_video_end_to_end() {
        let statuses = media_core::detect_all(&std::collections::HashMap::new());
        let ffmpeg = statuses.iter().find(|s| s.id == "ffmpeg" && s.ok)
            .and_then(|s| s.path.clone());
        let ffprobe = statuses.iter().find(|s| s.id == "ffprobe" && s.ok)
            .and_then(|s| s.path.clone());
        let (Some(ffmpeg), Some(ffprobe)) = (ffmpeg, ffprobe) else {
            eprintln!("skipping: no real ffmpeg/ffprobe found on this machine");
            return;
        };

        let out = std::env::temp_dir().join("media-server-test-real.mp4");
        let status = std::process::Command::new(&ffmpeg)
            .args(["-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=5:duration=1",
                   "-pix_fmt", "yuv420p"])
            .arg(&out)
            .status()
            .expect("could not run ffmpeg to build the fixture");
        assert!(status.success());

        let backends = media_core::Backends::default();
        backends.set("ffmpeg", Some(std::path::PathBuf::from(ffmpeg)));
        backends.set("ffprobe", Some(std::path::PathBuf::from(ffprobe)));
        let ctx = test_ctx(backends);

        let res = serve_meta(&ctx, &out);
        assert_eq!(res.status(), StatusCode::OK);
        let body = String::from_utf8(body_bytes(res).await).unwrap();
        assert!(body.contains("\"videoCodec\""), "body was: {body}");
        assert!(body.contains("\"verdict\""), "body was: {body}");

        let _ = std::fs::remove_file(&out);
    }
}
