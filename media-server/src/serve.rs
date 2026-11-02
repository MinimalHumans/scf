// SPDX-License-Identifier: Apache-2.0
//! The HTTP side: token and Host checks, routing, Range-aware file
//! serving for `/media` (docs/media-server-spec.md §4-§5, Phase 2),
//! ffprobe-based facts plus a verdict for `/meta` (Phase 3), the
//! ffmpeg-backed cache/queue for video/audio (Phase 4), and the
//! oiiotool/magick-backed still pipeline for EXR/TIFF/PSD/HEIC/DPX
//! (Phase 5, this module's `serve_still_media`/`still_meta_response`).
//!
//! Phase 8 adds a `priority` query param (spec §6's three tiers,
//! parsed by `queue::Priority`; unrecognized or absent means
//! `"requested"`, exactly today's behavior) and, only when a caller
//! opts into `priority=preview` on a still-running transcode,
//! progressive delivery straight from that job's growing `.part` file
//! (`serve_growing_file`) instead of the usual `202` — see
//! `convert.rs`'s fragmented-MP4 output, which is what makes a partial
//! file playable at all. Every other caller — in particular
//! `startConversion`'s explicit "Convert for preview" kick-off, which
//! depends on always getting a `202` back — is unaffected.

use std::convert::Infallible;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::{Request, Response, StatusCode};

use media_core::Verdict;

use crate::queue::StillRenderRequest;
use crate::{Handles, Queue};

#[derive(Clone)]
pub struct Context {
    pub port: u16,
    pub token: String,
    pub handles: Handles,
    pub backends: media_core::Backends,
    pub capabilities: media_core::Capabilities,
    pub probe_cache: media_core::ProbeCache,
    pub still_probe_cache: media_core::StillProbeCache,
    pub queue: Queue,
}

/// `/media`'s query-string options, bundled (Phase 8) so `serve_media`/
/// `serve_still_media` don't each carry three more loose parameters on
/// top of everything else they already take. `layer`/`channel` only
/// ever matter for an EXR; `priority` is spec §6's three tiers, parsed
/// by `priority_param`.
#[derive(Clone, Copy)]
struct MediaRequest<'a> {
    layer: Option<&'a str>,
    channel: Option<&'a str>,
    priority: &'a str,
}

/// Still formats a browser can never natively decode but that a
/// backend (Phase 5) might be able to flatten — checked *before*
/// ffprobe is even tried, since these aren't ffprobe's turf at all
/// (unlike video/audio, where probing might incidentally fail for
/// other reasons). Each maps to the one backend id that can read it
/// (spec §3's backend-role table): oiiotool for EXR/DPX (layer/
/// channel introspection, OCIO), magick for the rest (flatten only).
fn still_backend_for(ext: &str) -> Option<&'static str> {
    match ext {
        "exr" | "dpx" => Some("oiiotool"),
        "tif" | "tiff" | "psd" | "heic" | "heif" => Some("magick"),
        _ => None,
    }
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

/// Spec §6's three priority tiers, read straight off the query string
/// (Phase 8) — anything other than `"preview"`/`"background"` means
/// `"requested"`, which is also what an absent `priority` param means,
/// so every caller from before this phase keeps its exact previous
/// behavior.
fn priority_param(query: &str) -> &'static str {
    match query_param(query, "priority") {
        Some("preview") => "preview",
        Some("background") => "background",
        _ => "requested",
    }
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

    // `/jobs` (no id) is the dashboard's own route (Phase 7, spec §9):
    // the recent job list plus worker slot usage, addressed by nothing
    // at all — same reason `/jobs/...` below needs no asset handle.
    if route == "/jobs" {
        return serve_jobs_list(ctx);
    }

    // `/jobs/...` is addressed by job id, not an asset handle — routed
    // before the handle lookup below, which the other two routes need
    // and this one doesn't.
    if let Some(rest) = route.strip_prefix("/jobs/") {
        return if let Some(job_id) = rest.strip_suffix("/cancel") {
            if req.method() == hyper::Method::POST {
                serve_job_cancel(ctx, job_id)
            } else {
                text(StatusCode::METHOD_NOT_ALLOWED, "POST only")
            }
        } else if let Some(job_id) = rest.strip_suffix("/retry") {
            if req.method() == hyper::Method::POST {
                serve_job_retry(ctx, job_id)
            } else {
                text(StatusCode::METHOD_NOT_ALLOWED, "POST only")
            }
        } else if let Some(job_id) = rest.strip_suffix("/priority") {
            if req.method() == hyper::Method::POST {
                let query = req.uri().query().unwrap_or("").to_string();
                serve_job_priority(ctx, job_id, priority_param(&query))
            } else {
                text(StatusCode::METHOD_NOT_ALLOWED, "POST only")
            }
        } else {
            serve_job_status(ctx, rest)
        };
    }

    let Some(handle) = query_param(req.uri().query().unwrap_or(""), "h") else {
        return text(StatusCode::BAD_REQUEST, "missing h");
    };
    let Some(resolved) = ctx.handles.resolve(handle) else {
        return text(StatusCode::NOT_FOUND, "unknown or stale handle");
    };
    let path = resolved.path;
    let project_ids = resolved.project_ids;
    match route.as_str() {
        "/media" => {
            let range_header = req
                .headers()
                .get(hyper::header::RANGE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let query = req.uri().query().unwrap_or("").to_string();
            let request = MediaRequest {
                layer: query_param(&query, "layer"),
                channel: query_param(&query, "channel"),
                priority: priority_param(&query),
            };
            serve_media(ctx, Path::new(&path), range_header.as_deref(), request, &project_ids)
        }
        "/meta" => serve_meta(ctx, Path::new(&path)),
        _ => text(StatusCode::NOT_FOUND, "no such route"),
    }
}

/// The dashboard's queue/failures list plus worker status (Phase 7,
/// spec §9) in one response — the frontend buckets the same list by
/// `state` into "Queue" and "Failures" rather than this making two
/// round trips for what's one query either way (`Cache::
/// list_recent_jobs`'s own doc comment). `fileName` is a basename,
/// never `job.inputPath`'s real absolute path, and `stderrTail` is
/// already redacted of one by `queue.rs`'s `Failure::from_wait` before
/// it was ever stored — nothing here needs to re-check either, but the
/// basename-only rule is enforced right at this boundary regardless of
/// what a future caller of `list_recent_jobs` might do with the full
/// path (spec §13: no absolute path anywhere in the API).
fn serve_jobs_list(ctx: &Context) -> Res {
    let jobs: Vec<_> = ctx.queue.cache().list_recent_jobs(200).into_iter().map(|j| {
        let file_name = j.input_path.as_deref()
            .and_then(|p| Path::new(p).file_name())
            .and_then(|n| n.to_str());
        // Live `fs::metadata`, not a stored column: the source file is
        // still right there at its original path for as long as the job
        // exists, so there's no need to have copied its size into
        // `jobs` at creation time just to show it here. `None` (never
        // an error) when the source is gone or this is an old job
        // row with no `input_path` at all — the dashboard just omits
        // the figure rather than showing a stale or fabricated one.
        let source_bytes = j.input_path.as_deref()
            .and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len());
        // The `.part` file's current size — a running conversion's own
        // best evidence of how much it has produced so far. Never a
        // "projected final size": extrapolating from progress is a
        // guess this deliberately doesn't make (see the Media tab's own
        // "written so far" label, not "estimated size").
        let partial_bytes = (j.state == media_core::JobState::Running)
            .then(|| std::fs::metadata(ctx.queue.cache().tmp_path(&j.id)).ok())
            .flatten().map(|m| m.len());
        serde_json::json!({
            "id": j.id, "state": j.state, "error": j.error, "stderrTail": j.stderr_tail,
            "priority": j.priority, "backendId": j.backend_id, "fileName": file_name,
            "progress": ctx.queue.progress_of(&j.id),
            "sourceBytes": source_bytes, "partialBytes": partial_bytes,
            "createdAt": j.created_at, "startedAt": j.started_at, "finishedAt": j.finished_at,
        })
    }).collect();
    json(StatusCode::OK, &serde_json::json!({ "jobs": jobs, "workers": ctx.queue.worker_status() }))
}

fn serve_job_status(ctx: &Context, job_id: &str) -> Res {
    let Some(job) = ctx.queue.cache().get_job(job_id) else {
        return json(StatusCode::NOT_FOUND, &serde_json::json!({ "error": "unknown job" }));
    };
    let progress = ctx.queue.progress_of(job_id);
    json(StatusCode::OK, &serde_json::json!({
        "id": job.id, "state": job.state, "error": job.error, "progress": progress,
    }))
}

fn serve_job_cancel(ctx: &Context, job_id: &str) -> Res {
    ctx.queue.cancel(job_id);
    json(StatusCode::OK, &serde_json::json!({ "ok": true }))
}

/// The Media tab's up/down priority chevrons: bumps `job_id` between
/// the three tiers (`priority_param` already normalizes anything else
/// to `"requested"`). Updates the job's stored priority immediately;
/// for a job still `queued` (not yet running), also gives it an
/// immediate shot at `Queue::preempt_if_needed` under its new priority
/// — otherwise a tokio `Semaphore`'s FIFO wait list would never reorder
/// it on its own, and "bump to preview" would do nothing until its turn
/// came up anyway. A job that's already `running`, or one unknown to
/// this queue (finished, or never existed), is a quiet no-op either
/// way — there's nothing left to preempt it into, or out of.
fn serve_job_priority(ctx: &Context, job_id: &str, priority: &str) -> Res {
    ctx.queue.set_priority(job_id, priority);
    json(StatusCode::OK, &serde_json::json!({ "ok": true }))
}

/// The explicit "Retry" action (spec §7 "Manual actions") for a failed
/// job: drops its cache key's negative-cache row so the next `/media`
/// request for it attempts again. Addressed by job id, like cancel,
/// rather than by the raw cache key — the frontend only ever sees job
/// ids (from a `202`'s body or the future dashboard's failures list),
/// never a key.
fn serve_job_retry(ctx: &Context, job_id: &str) -> Res {
    let Some(job) = ctx.queue.cache().get_job(job_id) else {
        return json(StatusCode::NOT_FOUND, &serde_json::json!({ "error": "unknown job" }));
    };
    ctx.queue.cache().retry_failure(&job.key);
    json(StatusCode::OK, &serde_json::json!({ "ok": true }))
}

/// `/media`: raw passthrough (Phase 2) for anything ffprobe can't or
/// doesn't need to weigh in on — unchanged from before this phase, and
/// still the outcome for every image and every format outside Phase
/// 3's `PROBEABLE` list, which is most of a real project's assets. Only
/// when probing succeeds does a verdict actually decide anything (the
/// plan's decision 6). Phase 5's still formats are checked first and
/// routed to `serve_still_media` entirely separately — they are never
/// ffprobe's turf to begin with, not a case where probing might
/// incidentally fail for some other reason.
fn serve_media(
    ctx: &Context, path: &Path, range_header: Option<&str>,
    request: MediaRequest<'_>, project_ids: &[String],
) -> Res {
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        if let Some(backend_id) = still_backend_for(&ext.to_lowercase()) {
            return serve_still_media(ctx, path, range_header, backend_id, request, project_ids);
        }
    }

    let Some(ffprobe) = ctx.backends.get("ffprobe") else {
        return serve_file(path, range_header);
    };
    let Ok(probe) = ctx.probe_cache.probe(&ffprobe, path) else {
        return serve_file(path, range_header);
    };
    let verdict = media_core::classify(&probe, &ctx.capabilities, &ctx.backends);

    match verdict {
        Verdict::Passthrough => serve_file(path, range_header),
        Verdict::Unsupported => json(StatusCode::UNSUPPORTED_MEDIA_TYPE, &serde_json::json!({
            "error": "the browser can't decode this, and nothing here can convert it either",
        })),
        Verdict::Remux | Verdict::Transcode => {
            let Ok(sig) = media_core::source_signature(path) else {
                return serve_file(path, range_header); // can't sign it; raw is still a valid answer
            };
            let ffmpeg = ctx.backends.get("ffmpeg")
                .expect("classify() only returns Remux/Transcode when ffmpeg is configured");
            let version = ctx.backends.version("ffmpeg");
            // Phase 8: a hardware encoder is only ever relevant to an
            // actual encode — remux (`-c copy`) never touches it, so
            // its cache key stays unaffected by whatever GPU happens to
            // be in this machine.
            let mut params = crate::queue::default_derived_params(ctx.queue.runtime().resolution_cap());
            if verdict == Verdict::Transcode {
                params.hardware_encoder = ctx.backends.best_hw_encoder("ffmpeg");
            }
            let key = media_core::cache_key(
                sig, "ffmpeg", &version, media_core::PROFILE_VERSION, &params);

            for pid in project_ids {
                ctx.queue.cache().add_ref(pid, &key);
            }

            let response = if let Some(entry) = ctx.queue.cache().get_entry(&key) {
                ctx.queue.cache().touch_entry(&key);
                serve_file(Path::new(&entry.path_on_disk), range_header)
            } else if let Some(error) = ctx.queue.cache().failure(&key) {
                json(StatusCode::UNPROCESSABLE_ENTITY, &serde_json::json!({ "error": error }))
            } else {
                let job_id = ctx.queue.enqueue(crate::queue::EnqueueRequest {
                    key: &key, priority: request.priority, input: path, verdict,
                    backend_id: "ffmpeg", backend: &ffmpeg,
                    duration_secs: probe.duration_secs, still: None,
                    derived_params: params,
                });

                // Phase 8, spec §6 "Video delivery before completion":
                // only when the caller opted in with `priority=preview`
                // (never for `startConversion`'s plain kick-off, which
                // depends on always getting a `202` here) and the job
                // is a transcode already running — a brand-new job's
                // `.part` is still empty, so this is a no-op for it.
                let progressive = (request.priority == "preview" && verdict == Verdict::Transcode)
                    .then(|| ctx.queue.cache().get_job(&job_id))
                    .flatten()
                    .filter(|j| j.state == media_core::JobState::Running)
                    .and_then(|_| serve_growing_file(&ctx.queue.cache().tmp_path(&job_id), range_header));

                progressive.unwrap_or_else(|| json(StatusCode::ACCEPTED, &serde_json::json!({
                    "jobId": job_id, "state": "queued",
                })))
            };

            // Enforcement "at write time" (spec §6/§7): after the
            // request that may have just grown this project's usage,
            // not before — `touch_entry` above needs to have run first
            // so a hit on the entry itself never reads as its own LRU
            // candidate.
            for pid in project_ids {
                ctx.queue.cache().enforce_quota(pid, &media_core::VIDEO_KINDS, ctx.queue.video_cap_bytes_for(pid));
            }
            response
        }
        Verdict::Render => unreachable!("still formats never reach classify() — see still_backend_for"),
    }
}

/// Phase 5's still-image counterpart to the video branch above: probe
/// via whichever backend `still_backend_for` named, classify (always
/// `Render` when a backend exists, `Unsupported` otherwise — spec §5's
/// explicit "no backend -> fall back to raw passthrough or 415"
/// fallback is `Unsupported`'s case here), then the same cache-hit/
/// failure/enqueue-202 branching the video path uses. `layer`/
/// `channel` only ever matter for an EXR (oiiotool); forcing them to
/// `None` for every other extension in `resolve_still_selection` means
/// a stray query param on a PSD request is silently ignored, not an
/// error.
fn serve_still_media(
    ctx: &Context, path: &Path, range_header: Option<&str>, backend_id: &str,
    request: MediaRequest<'_>, project_ids: &[String],
) -> Res {
    let (layer, channel) = (request.layer, request.channel);
    let Some(backend_path) = ctx.backends.get(backend_id) else {
        return serve_file(path, range_header); // spec §5: no backend -> raw passthrough
    };
    let probe_result = if backend_id == "oiiotool" {
        ctx.still_probe_cache.probe_oiiotool(&backend_path, path)
    } else {
        ctx.still_probe_cache.probe_magick(&backend_path, path)
    };
    let Ok(probe) = probe_result else {
        return json(StatusCode::UNSUPPORTED_MEDIA_TYPE, &serde_json::json!({
            "error": format!("{backend_id} could not read this file"),
        }));
    };
    let verdict = media_core::classify_still(&probe, true);
    if verdict == Verdict::Unsupported {
        return json(StatusCode::UNSUPPORTED_MEDIA_TYPE, &serde_json::json!({
            "error": "the browser can't decode this, and nothing here can convert it either",
        }));
    }

    let Ok(sig) = media_core::source_signature(path) else {
        return serve_file(path, range_header); // can't sign it; raw is still a valid answer
    };
    let version = ctx.backends.version(backend_id);
    // The *raw* request strings, not the resolved selection — two
    // requests that happen to resolve to the same effective layer
    // (e.g. no `layer` given vs. explicitly naming the default one)
    // may get separate cache entries for the identical result, which
    // is a minor inefficiency, not a correctness problem; resolving
    // first would need `StillSelection` to also carry the chosen
    // layer's *name* back out (today it only carries the channels
    // already filtered by it), which is more plumbing than this
    // phase's scope calls for.
    let params = media_core::DerivedParams {
        layer: layer.map(str::to_string), channel: channel.map(str::to_string),
        resolution_cap: 0, crf: 0, hardware_encoder: None,
    };
    let key = media_core::cache_key(sig, backend_id, &version, media_core::PROFILE_VERSION, &params);
    let selection = media_core::resolve_still_selection(&probe, layer, channel);

    for pid in project_ids {
        ctx.queue.cache().add_ref(pid, &key);
    }

    let response = if let Some(entry) = ctx.queue.cache().get_entry(&key) {
        ctx.queue.cache().touch_entry(&key);
        serve_file(Path::new(&entry.path_on_disk), range_header)
    } else if let Some(error) = ctx.queue.cache().failure(&key) {
        json(StatusCode::UNPROCESSABLE_ENTITY, &serde_json::json!({ "error": error }))
    } else {
        let job_id = ctx.queue.enqueue(crate::queue::EnqueueRequest {
            key: &key, priority: request.priority, input: path, verdict,
            backend_id, backend: &backend_path, duration_secs: None,
            still: Some(StillRenderRequest { selection, width: probe.width, height: probe.height }),
            derived_params: params,
        });
        json(StatusCode::ACCEPTED, &serde_json::json!({ "jobId": job_id, "state": "queued" }))
    };

    for pid in project_ids {
        ctx.queue.cache().enforce_quota(pid, &media_core::STILL_KINDS, ctx.queue.still_cap_bytes_for(pid));
    }
    response
}

/// `/meta` for a still format: the same `probe`/`verdict` shape video
/// gets (via `StillProbeResult`'s `ProbeResult` conversion, so the
/// frontend's `AssetMeta` type needs no still-specific probe shape),
/// plus `layers`/`channels` — empty whenever the backend is magick or
/// has no layer structure to report, which the frontend reads as
/// "nothing to pick," not an error (spec §4: "Frontend builds the
/// layer picker from this").
fn serve_still_meta(ctx: &Context, path: &Path, backend_id: &str) -> Res {
    let Some(backend_path) = ctx.backends.get(backend_id) else {
        return json(StatusCode::SERVICE_UNAVAILABLE, &serde_json::json!({
            "error": format!("{backend_id} is not configured — see Settings \u{2192} Backends"),
        }));
    };
    let probe_result = if backend_id == "oiiotool" {
        ctx.still_probe_cache.probe_oiiotool(&backend_path, path)
    } else {
        ctx.still_probe_cache.probe_magick(&backend_path, path)
    };
    match probe_result {
        Ok(result) => {
            let verdict = media_core::classify_still(&result, true);
            let probe: media_core::ProbeResult = (&result).into();
            json(StatusCode::OK, &serde_json::json!({
                "probe": probe, "verdict": verdict,
                "layers": result.layers, "channels": result.channels,
            }))
        }
        Err(e) => json(StatusCode::UNPROCESSABLE_ENTITY, &serde_json::json!({ "error": e })),
    }
}

fn json(status: StatusCode, body: &serde_json::Value) -> Res {
    Response::builder()
        .status(status)
        .header(hyper::header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap()
}

/// ffprobe-based facts and a verdict for video/audio, or (Phase 5)
/// oiiotool/magick-based facts plus layer/channel list for a still —
/// "Frontend builds the layer picker from this" (spec §4). Checked
/// first, same as `serve_media`: a still extension is never ffprobe's
/// turf to begin with.
fn serve_meta(ctx: &Context, path: &Path) -> Res {
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        if let Some(backend_id) = still_backend_for(&ext.to_lowercase()) {
            return serve_still_meta(ctx, path, backend_id);
        }
    }

    let Some(ffprobe) = ctx.backends.get("ffprobe") else {
        return json(StatusCode::SERVICE_UNAVAILABLE, &serde_json::json!({
            "error": "ffprobe is not configured — see Settings \u{2192} Backends",
        }));
    };
    match ctx.probe_cache.probe(&ffprobe, path) {
        Ok(result) => {
            let verdict = media_core::classify(&result, &ctx.capabilities, &ctx.backends);
            // `layers`/`channels` are always present in a `/meta`
            // response, even here where video/audio never has any —
            // one JSON shape for both, so the frontend's `AssetMeta`
            // type needs no per-kind optionality.
            json(StatusCode::OK, &serde_json::json!({
                "probe": result, "verdict": verdict,
                "layers": Vec::<String>::new(), "channels": Vec::<String>::new(),
            }))
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

/// Phase 8, spec §6 "Video delivery before completion": like
/// `serve_file`, but for a transcode job's still-growing `.part`
/// output rather than a finished entry. Re-stats the file on every
/// call rather than trusting any cached length — the whole trick is
/// that the file keeps growing between requests, and each request
/// just reads whatever is on disk *right now*.
///
/// Differs from `serve_file` in exactly the two places "it might get
/// longer" matters: a range past the current end gets a `503` with
/// `Retry-After` (the bytes may exist very soon) instead of a
/// permanent `416`, and a satisfied range's `Content-Range` reports
/// the total as `*` (RFC 7233: unknown) rather than this instant's
/// length, which the next request may already have grown past.
///
/// `None` when there's nothing worth serving yet — no `.part` file, or
/// an empty one (ffmpeg hasn't flushed its first fragment) — so the
/// caller falls back to the ordinary `202`, same as every phase before
/// this one.
fn serve_growing_file(tmp: &Path, range_header: Option<&str>) -> Option<Res> {
    let mut file = File::open(tmp).ok()?;
    let len = file.metadata().ok()?.len();
    if len == 0 {
        return None;
    }

    let outcome = range_header.map_or(RangeOutcome::Full, |h| parse_range(h, len));
    Some(match outcome {
        RangeOutcome::Unsatisfiable => Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header(hyper::header::RETRY_AFTER, "1")
            .body(Full::new(Bytes::new()))
            .unwrap(),
        RangeOutcome::Range(start, end) => {
            let count = (end - start + 1) as usize;
            if file.seek(SeekFrom::Start(start)).is_err() {
                return Some(text(StatusCode::INTERNAL_SERVER_ERROR, "seek failed"));
            }
            let mut buf = vec![0u8; count];
            if file.read_exact(&mut buf).is_err() {
                return Some(text(StatusCode::INTERNAL_SERVER_ERROR, "read failed"));
            }
            Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(hyper::header::CONTENT_TYPE, "video/mp4")
                .header(hyper::header::ACCEPT_RANGES, "bytes")
                .header(hyper::header::CONTENT_RANGE, format!("bytes {start}-{end}/*"))
                .header(hyper::header::CONTENT_LENGTH, count.to_string())
                .body(Full::new(Bytes::from(buf)))
                .unwrap()
        }
        RangeOutcome::Full => {
            let mut buf = Vec::with_capacity(len as usize);
            if file.read_to_end(&mut buf).is_err() {
                return Some(text(StatusCode::INTERNAL_SERVER_ERROR, "read failed"));
            }
            Response::builder()
                .status(StatusCode::OK)
                .header(hyper::header::CONTENT_TYPE, "video/mp4")
                .header(hyper::header::ACCEPT_RANGES, "bytes")
                .header(hyper::header::CONTENT_LENGTH, buf.len().to_string())
                .body(Full::new(Bytes::from(buf)))
                .unwrap()
        }
    })
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

    /// Phase 8's progressive delivery: nothing to serve yet means
    /// `None`, not an empty `200` — the caller falls back to the
    /// ordinary `202`.
    #[test]
    fn serve_growing_file_is_none_for_a_missing_or_empty_part() {
        let missing = std::env::temp_dir().join("media-server-test-no-such-part.part");
        assert!(serve_growing_file(&missing, None).is_none());

        let empty = TempFile::with_bytes("empty.part", b"");
        assert!(serve_growing_file(&empty.path, None).is_none());
    }

    #[tokio::test]
    async fn serve_growing_file_serves_whatever_is_on_disk_right_now() {
        let file = TempFile::with_bytes("growing-full.part", b"hello world");
        let res = serve_growing_file(&file.path, None).unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_bytes(res).await, b"hello world");
    }

    /// A range already available on disk comes back as `206`, but with
    /// the total reported as `*` (unknown) rather than this instant's
    /// length — the next request may already have grown past it.
    #[tokio::test]
    async fn serve_growing_file_reports_an_unknown_total_length_on_a_satisfied_range() {
        let file = TempFile::with_bytes("growing-ranged.part", b"hello world");
        let res = serve_growing_file(&file.path, Some("bytes=6-10")).unwrap();
        assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
        let content_range = res.headers().get(hyper::header::CONTENT_RANGE).unwrap().clone();
        assert_eq!(content_range, "bytes 6-10/*");
        assert_eq!(body_bytes(res).await, b"world");
    }

    /// A range past what's on disk *yet* is a `503` ("try again
    /// shortly"), never the permanent `416` `serve_file` would give a
    /// finished file for the same request.
    #[test]
    fn serve_growing_file_answers_a_range_past_the_current_end_with_a_retryable_503() {
        let file = TempFile::with_bytes("growing-not-yet.part", b"hello world");
        let res = serve_growing_file(&file.path, Some("bytes=1000-2000")).unwrap();
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(res.headers().get(hyper::header::RETRY_AFTER).is_some());
    }

    fn test_ctx(backends: media_core::Backends) -> Context {
        // A fresh, unique cache dir per context — never cleaned up, but
        // tiny (an empty SQLite file) and under the OS temp dir, same
        // tradeoff `serving_a_missing_file_is_404` already makes by not
        // cleaning up its path.
        static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir()
            .join(format!("media-server-test-ctx-{}-{n}", std::process::id()));
        let cache = media_core::Cache::open(dir).unwrap();
        Context {
            port: 0,
            token: "tok".to_string(),
            handles: Handles::default(),
            backends,
            capabilities: media_core::Capabilities::default(),
            probe_cache: media_core::ProbeCache::default(),
            still_probe_cache: media_core::StillProbeCache::default(),
            queue: crate::Queue::new(
                cache, crate::queue::QueueConfig::default(), crate::queue::RuntimeSettings::default()),
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

    /// Spec §5's explicit "no backend -> raw passthrough" fallback,
    /// applied to a still format: with no oiiotool configured, an EXR
    /// is served exactly as Phase 2 always has, not blocked or errored
    /// — true and checkable on any machine, no real oiiotool needed.
    #[tokio::test]
    async fn an_exr_with_no_backend_configured_falls_back_to_passthrough() {
        let ctx = test_ctx(media_core::Backends::default());
        let data = b"not really an exr, content doesn't matter here";
        let file = TempFile::with_bytes("fake.exr", data);
        let res = serve_media(
            &ctx, &file.path, None,
            MediaRequest { layer: None, channel: None, priority: "requested" }, &[],
        );
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_bytes(res).await, data);
    }

    /// A backend *is* configured but can't actually read this file —
    /// 415, not a silent passthrough or a crash. Deterministic: the
    /// configured path doesn't need to be a real binary for `magick
    /// identify` to fail to spawn it.
    #[tokio::test]
    async fn a_still_backend_configured_but_broken_is_415() {
        let backends = media_core::Backends::default();
        backends.set("magick", Some(std::path::PathBuf::from("Z:/definitely/not/magick.exe")));
        let ctx = test_ctx(backends);
        let file = TempFile::with_bytes("broken.tiff", b"whatever");
        let res = serve_media(
            &ctx, &file.path, None,
            MediaRequest { layer: None, channel: None, priority: "requested" }, &[],
        );
        assert_eq!(res.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    #[tokio::test]
    async fn retrying_an_unknown_job_is_404() {
        let ctx = test_ctx(media_core::Backends::default());
        let res = serve_job_retry(&ctx, "not-a-real-job-id");
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    /// `serve_job_retry` is addressed by job id (spec §7 "Manual
    /// actions": Retry), not by the cache key the negative cache is
    /// actually keyed on — this confirms it resolves one to the other
    /// correctly, the one piece of Phase 6's retry wiring `cache.rs`'s
    /// own tests (keyed directly) can't cover.
    #[tokio::test]
    async fn retrying_a_failed_job_clears_its_negative_cache_entry() {
        let ctx = test_ctx(media_core::Backends::default());
        let job_id = ctx.queue.cache().create_job("some-key", "requested", "ffmpeg", "in.mp4");
        ctx.queue.cache().record_failure("some-key", "ffmpeg exited with code 1");
        assert!(ctx.queue.cache().failure("some-key").is_some());

        let res = serve_job_retry(&ctx, &job_id);
        assert_eq!(res.status(), StatusCode::OK);
        assert!(ctx.queue.cache().failure("some-key").is_none());
    }

    /// Phase 7's dashboard route: the job list carries a bare file
    /// name (never `job.input_path`'s real absolute path — spec §13),
    /// plus the worker status `/jobs` bundles alongside it.
    #[tokio::test]
    async fn jobs_list_reports_a_file_name_not_a_full_path_and_the_worker_status() {
        let ctx = test_ctx(media_core::Backends::default());
        let id = ctx.queue.cache().create_job(
            "some-key", "requested", "ffmpeg", "C:\\plates\\shot01.mov");
        ctx.queue.cache().set_job_failed(&id, "ffmpeg exited with 1", Some("shot01.mov: broken"));

        let res = serve_jobs_list(&ctx);
        assert_eq!(res.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_slice(&body_bytes(res).await).unwrap();

        let job = &body["jobs"][0];
        assert_eq!(job["fileName"], "shot01.mov");
        assert_eq!(job["id"], id);
        assert_eq!(job["state"], "failed");
        assert!(!job.to_string().contains("C:\\\\plates"), "the full path must never appear");

        assert_eq!(body["workers"]["videoMax"], 1);
    }

    /// The full still `/media` loop against a real magick-flattenable
    /// file: first request -> `202` + a job id; poll until `done`;
    /// second request -> `200` serving a real, non-empty JPEG. Mirrors
    /// `media_queues_a_remux_and_then_serves_the_cached_result` below.
    /// Ignored by default — run with `cargo test -p media-server --
    /// --ignored`.
    #[tokio::test]
    #[ignore = "depends on this machine's installed backends"]
    async fn media_queues_a_still_render_and_then_serves_the_cached_result() {
        let statuses = media_core::detect_all(&std::collections::HashMap::new());
        let Some(magick) = statuses.iter().find(|s| s.id == "magick" && s.ok)
            .and_then(|s| s.path.clone()) else {
            eprintln!("skipping: no real magick found on this machine");
            return;
        };

        let dir = std::env::temp_dir()
            .join(format!("media-server-test-still-render-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("in.tiff");
        let status = std::process::Command::new(&magick)
            .args(["-size", "16x16", "gradient:blue-yellow"])
            .arg(&input)
            .status()
            .unwrap();
        assert!(status.success());

        let backends = media_core::Backends::default();
        backends.set("magick", Some(std::path::PathBuf::from(&magick)));
        let ctx = test_ctx(backends);

        let project_ids = vec!["proj-still-test".to_string()];
        let first = serve_media(
            &ctx, &input, None,
            MediaRequest { layer: None, channel: None, priority: "requested" }, &project_ids,
        );
        assert_eq!(first.status(), StatusCode::ACCEPTED);
        let body: serde_json::Value =
            serde_json::from_slice(&body_bytes(first).await).unwrap();
        let job_id = body["jobId"].as_str().unwrap().to_string();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let job = ctx.queue.cache().get_job(&job_id).unwrap();
            match job.state {
                media_core::JobState::Done => break,
                media_core::JobState::Failed | media_core::JobState::Cancelled => {
                    panic!("job ended as {:?}: {:?}", job.state, job.error);
                }
                _ => {
                    assert!(std::time::Instant::now() < deadline, "job did not finish in time");
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        }

        let second = serve_media(
            &ctx, &input, None,
            MediaRequest { layer: None, channel: None, priority: "requested" }, &project_ids,
        );
        assert_eq!(second.status(), StatusCode::OK);
        let converted = body_bytes(second).await;
        assert!(!converted.is_empty());

        // Phase 6: the project that asked for this render now has a
        // tracked ref to it, and flushing that project reclaims the
        // file on disk.
        assert!(ctx.queue.cache().project_usage_bytes("proj-still-test", &media_core::STILL_KINDS) > 0);
        ctx.queue.cache().flush_project("proj-still-test");
        assert_eq!(ctx.queue.cache().project_usage_bytes("proj-still-test", &media_core::STILL_KINDS), 0);

        let _ = std::fs::remove_dir_all(&dir);
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

    /// The full `/media` loop against a real file that genuinely needs
    /// a remux: h264 in a Matroska container, decodable but not a
    /// container `verdict::NATIVE_CONTAINERS` recognises. First request
    /// -> `202` + a job id; poll until `done`; second request -> `200`
    /// serving the converted file, which reprobes as a native
    /// container. Ignored by default — run with `cargo test -p
    /// media-server -- --ignored`.
    #[tokio::test]
    #[ignore = "depends on this machine's installed backends"]
    async fn media_queues_a_remux_and_then_serves_the_cached_result() {
        let statuses = media_core::detect_all(&std::collections::HashMap::new());
        let ffmpeg = statuses.iter().find(|s| s.id == "ffmpeg" && s.ok)
            .and_then(|s| s.path.clone());
        let ffprobe = statuses.iter().find(|s| s.id == "ffprobe" && s.ok)
            .and_then(|s| s.path.clone());
        let (Some(ffmpeg), Some(ffprobe)) = (ffmpeg, ffprobe) else {
            eprintln!("skipping: no real ffmpeg/ffprobe found on this machine");
            return;
        };

        let dir = std::env::temp_dir()
            .join(format!("media-server-test-remux-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("in.mkv");
        let status = std::process::Command::new(&ffmpeg)
            .args(["-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=5:duration=1",
                   "-pix_fmt", "yuv420p", "-c:v", "libx264"])
            .arg(&input)
            .status()
            .unwrap();
        assert!(status.success());

        let backends = media_core::Backends::default();
        backends.set("ffmpeg", Some(std::path::PathBuf::from(&ffmpeg)));
        backends.set("ffprobe", Some(std::path::PathBuf::from(&ffprobe)));
        let ctx = test_ctx(backends);

        // Confirm the fixture actually needs a remux, not a passthrough
        // — otherwise this test would "pass" without exercising the
        // queue at all.
        let probe = ctx.probe_cache.probe(Path::new(&ffprobe), &input).unwrap();
        let verdict = media_core::classify(&probe, &ctx.capabilities, &ctx.backends);
        assert_eq!(verdict, media_core::Verdict::Remux, "fixture's verdict was {verdict:?}");

        let project_ids = vec!["proj-remux-test".to_string()];
        let first = serve_media(
            &ctx, &input, None,
            MediaRequest { layer: None, channel: None, priority: "requested" }, &project_ids,
        );
        assert_eq!(first.status(), StatusCode::ACCEPTED);
        let body: serde_json::Value =
            serde_json::from_slice(&body_bytes(first).await).unwrap();
        let job_id = body["jobId"].as_str().unwrap().to_string();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let job = ctx.queue.cache().get_job(&job_id).unwrap();
            match job.state {
                media_core::JobState::Done => break,
                media_core::JobState::Failed | media_core::JobState::Cancelled => {
                    panic!("job ended as {:?}: {:?}", job.state, job.error);
                }
                _ => {
                    assert!(std::time::Instant::now() < deadline, "job did not finish in time");
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        }

        let second = serve_media(
            &ctx, &input, None,
            MediaRequest { layer: None, channel: None, priority: "requested" }, &project_ids,
        );
        assert_eq!(second.status(), StatusCode::OK);
        let converted = body_bytes(second).await;
        assert!(!converted.is_empty());

        // The cached result is a genuinely different, now-native file —
        // not the original bytes handed back unchanged.
        let cached_path = dir.join("cached.mp4");
        std::fs::write(&cached_path, &converted).unwrap();
        let reprobed = media_core::probe(Path::new(&ffprobe), &cached_path).unwrap();
        assert_eq!(reprobed.container.as_deref(), Some("mov"));

        // Phase 6: the requesting project now has a tracked ref to the
        // converted entry, and flushing it reclaims the cache file.
        assert!(ctx.queue.cache().project_usage_bytes("proj-remux-test", &media_core::VIDEO_KINDS) > 0);
        ctx.queue.cache().flush_project("proj-remux-test");
        assert_eq!(ctx.queue.cache().project_usage_bytes("proj-remux-test", &media_core::VIDEO_KINDS), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Phase 8's progressive delivery, end to end: a real transcode (a
    /// codec outside `classify`'s `LIKELY_DECODABLE`, so it comes back
    /// `Transcode` against this test's default, nothing-reported
    /// `Capabilities`), long enough that it's still `running` by the
    /// time a follow-up request arrives. Only a `priority=preview`
    /// request ever sees this: it gets real bytes straight off the
    /// job's growing `.part` file instead of the usual `202`, well
    /// before the job itself reaches `done`. Ignored by default — run
    /// with `cargo test -p media-server -- --ignored`.
    #[tokio::test]
    #[ignore = "depends on this machine's installed backends"]
    async fn media_serves_a_running_transcode_progressively_when_asked_as_preview() {
        let statuses = media_core::detect_all(&std::collections::HashMap::new());
        let ffmpeg = statuses.iter().find(|s| s.id == "ffmpeg" && s.ok)
            .and_then(|s| s.path.clone());
        let ffprobe = statuses.iter().find(|s| s.id == "ffprobe" && s.ok)
            .and_then(|s| s.path.clone());
        let (Some(ffmpeg), Some(ffprobe)) = (ffmpeg, ffprobe) else {
            eprintln!("skipping: no real ffmpeg/ffprobe found on this machine");
            return;
        };

        let dir = std::env::temp_dir()
            .join(format!("media-server-test-progressive-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("in.mp4");
        // Big and long enough that the transcode is still running when
        // the follow-up request below arrives — the other fixtures
        // here are one tiny frame, already done by then.
        let status = std::process::Command::new(&ffmpeg)
            .args(["-y", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=8",
                   "-pix_fmt", "yuv420p", "-c:v", "mpeg2video"])
            .arg(&input)
            .status()
            .unwrap();
        assert!(status.success());

        let backends = media_core::Backends::default();
        backends.set("ffmpeg", Some(std::path::PathBuf::from(&ffmpeg)));
        backends.set("ffprobe", Some(std::path::PathBuf::from(&ffprobe)));
        let ctx = test_ctx(backends);

        let probe = ctx.probe_cache.probe(Path::new(&ffprobe), &input).unwrap();
        let verdict = media_core::classify(&probe, &ctx.capabilities, &ctx.backends);
        assert_eq!(verdict, media_core::Verdict::Transcode, "fixture's verdict was {verdict:?}");

        let project_ids = vec!["proj-progressive-test".to_string()];
        let first = serve_media(
            &ctx, &input, None,
            MediaRequest { layer: None, channel: None, priority: "preview" }, &project_ids,
        );
        assert_eq!(first.status(), StatusCode::ACCEPTED, "nothing on disk yet for the very first request");
        let body: serde_json::Value = serde_json::from_slice(&body_bytes(first).await).unwrap();
        let job_id = body["jobId"].as_str().unwrap().to_string();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut saw_progressive_bytes = false;
        while !saw_progressive_bytes {
            let job = ctx.queue.cache().get_job(&job_id).unwrap();
            assert_ne!(job.state, media_core::JobState::Failed, "{:?}", job.error);
            assert_ne!(job.state, media_core::JobState::Cancelled);
            if job.state == media_core::JobState::Done {
                break; // ran to completion before we ever caught it mid-flight; not a failure
            }
            assert!(std::time::Instant::now() < deadline, "job did not finish in time");

            let res = serve_media(
                &ctx, &input, None,
                MediaRequest { layer: None, channel: None, priority: "preview" }, &project_ids,
            );
            if res.status() == StatusCode::OK || res.status() == StatusCode::PARTIAL_CONTENT {
                saw_progressive_bytes = true;
                assert!(!body_bytes(res).await.is_empty());
            } else {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
        assert!(saw_progressive_bytes, "never observed bytes served from the still-running job");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
