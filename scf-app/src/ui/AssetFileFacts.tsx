// SPDX-License-Identifier: Apache-2.0
/**
 * AssetFileFacts — what the file itself says (metadata, not storage).
 *
 * Read from the bytes every time it is shown and never written to the
 * .scf. The row holds an address; dimensions, channels and duration are
 * facts about the CONTENT, and storing them would be a second copy of a
 * truth that changes without asking (conventions §2).
 *
 * The accepted cost is that none of this is queryable — a filter over
 * thousands of assets would mean reading thousands of files. If it
 * needs storing to be queried, it does not get queried.
 *
 * Two sources, in the order they are cheap:
 *   header  — the first 96KB, parsed in scf-core. No decoding, works
 *             for EXR and glTF where preview cannot.
 *   probed  — resolution, duration, fps and codec for video/audio, via
 *             the media server's `/meta` route (docs/media-server-
 *             spec.md §5, Phase 3). ffprobe reads these without ever
 *             loading the file into the browser, so this works for a
 *             `decoded`-tier `.mov`/`.mxf` exactly as well as for a
 *             playable `.mp4` — the two cases `previewCapability()`
 *             cannot otherwise tell apart (same extension, different
 *             codec inside).
 */

import { Fragment, useEffect, useState } from "react";
import {
  HEADER_BYTES, readHeaderMetadata, type FileMetadata,
} from "@scf-core/fileMetadata.ts";
import { formatOf, parseIdentifier } from "@scf-core/assets.ts";
import { PROBEABLE, STILL_BACKEND } from "@scf-core/preview.ts";
import { readAssetBytes } from "../files/assetLocator.ts";
import {
  acquire, acquireMeta, cancelJob, jobStatus, startConversion,
  type AssetMeta, type JobStatus,
} from "../files/objectUrlCache.ts";
import { reportMediaCapabilities } from "../state/mediaCapabilities.ts";
import { useStore } from "../state/store.ts";

/** How often to poll a queued/running job — frequent enough to feel
 *  live, far below anything worth debouncing on the server side. */
const POLL_MS = 750;

type ConvertState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "polling"; jobId: string; status: JobStatus }
  | { kind: "done"; url: string }
  | { kind: "error"; message: string };

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function humanDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${String(h)}:${pad(m)}:${pad(sec)}` : `${String(m)}:${pad(sec)}`;
}

/** `remux`/`transcode` get the "Convert for preview" action below
 *  instead (Phase 4) — both verdicts only ever come back when ffmpeg
 *  is configured (`media-core`'s `classify()`), so the button always
 *  has something that can actually do the work. `render` (Phase 5)
 *  needs nothing here either — `AssetPreview.tsx` already requests it
 *  automatically, so there's nothing left for this panel to add.
 *  `unsupported` still gets a plain sentence: nothing here can help
 *  with it either way. */
const VERDICT_NOTE: Record<AssetMeta["verdict"], string | null> = {
  passthrough: null,
  remux: null,
  transcode: null,
  render: null,
  unsupported: "the browser can't decode this, and nothing here can " +
               "convert it either",
};

export function AssetFileFacts({ identifier }: {
  identifier: string | null;
}): JSX.Element | null {
  const { assetRoot } = useStore();
  const [meta, setMeta] = useState<FileMetadata | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [modified, setModified] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [probed, setProbed] = useState<AssetMeta | null>(null);
  const [convert, setConvert] = useState<ConvertState>({ kind: "idle" });

  const root = assetRoot;
  const parsed = identifier === null ? null : parseIdentifier(identifier);

  useEffect(() => {
    let cancelled = false;
    setMeta(null);
    setSize(null);
    setModified(null);
    setMissing(false);

    void (async () => {
      if (parsed === null || root === null || parsed.root !== "project") {
        return;
      }
      const read = await readAssetBytes(root, parsed.path, HEADER_BYTES);
      if (cancelled) return;
      if (read === null) { setMissing(true); return; }
      setSize(read.size);
      setModified(new Date(read.lastModified).toLocaleString());
      setMeta(readHeaderMetadata(new Uint8Array(read.bytes)));
    })();

    return () => { cancelled = true; };
  }, [identifier, root]);

  useEffect(() => {
    let cancelled = false;
    setProbed(null);
    if (parsed === null || root === null || parsed.root !== "project") return;
    const fmt = formatOf(identifier ?? "") ?? "";
    if (!PROBEABLE.includes(fmt) && !STILL_BACKEND.includes(fmt)) return;

    void (async () => {
      await reportMediaCapabilities();
      const result = await acquireMeta(root, parsed.path);
      if (!cancelled) setProbed(result);
    })();

    return () => { cancelled = true; };
  }, [identifier, root]);

  // A different asset is a clean slate — a conversion in flight for the
  // last one has no bearing on this one, and polling for it must stop.
  useEffect(() => { setConvert({ kind: "idle" }); }, [identifier, root]);

  useEffect(() => {
    if (convert.kind !== "polling") return;
    let cancelled = false;
    const jobId = convert.jobId;
    const timer = setInterval(() => {
      void jobStatus(jobId).then((status) => {
        if (cancelled || status === null) return;
        if (status.state === "done") {
          if (parsed !== null) {
            void acquire(root, parsed.path).then((url) => {
              if (!cancelled) {
                setConvert(url === null
                  ? { kind: "error", message: "converted, but could not load it" }
                  : { kind: "done", url });
              }
            });
          }
        } else if (status.state === "failed") {
          setConvert({ kind: "error", message: status.error ?? "conversion failed" });
        } else if (status.state === "cancelled") {
          setConvert({ kind: "idle" });
        } else {
          setConvert({ kind: "polling", jobId, status });
        }
      });
    }, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
    // `convert.status` deliberately excluded — re-running this effect
    // every time the poll updates it would restart the interval
    // instead of letting it tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convert.kind === "polling" ? convert.jobId : null, root, parsed?.path]);

  const startConvert = (): void => {
    if (parsed === null) return;
    setConvert({ kind: "starting" });
    void startConversion(root, parsed.path).then((jobId) => {
      setConvert(jobId === null
        ? { kind: "error", message: "could not start the conversion" }
        : { kind: "polling", jobId, status: { id: jobId, state: "queued", error: null, progress: null } });
    });
  };

  const cancelConvert = (): void => {
    if (convert.kind === "polling") {
      void cancelJob(convert.jobId);
      setConvert({ kind: "idle" });
    }
  };

  if (identifier === null) return null;
  if (missing) return null;          // resolution already reports this
  if (size === null) return null;

  return (
    <section className="asset-facts">
      <h4>File</h4>
      <dl className="identity-facts">
        <dt>size</dt>
        <dd>{humanBytes(size)}</dd>
        {modified !== null && (
          <>
            <dt>modified</dt>
            <dd>{modified}</dd>
          </>
        )}
        {meta !== null && meta.width !== null && (
          <>
            <dt>dimensions</dt>
            <dd>
              {meta.width}
              {meta.height !== null ? ` × ${meta.height}` : ""}
            </dd>
          </>
        )}
        {(meta?.fields ?? []).map((f) => (
          // A <dl> pairs dt with dd, so each pair needs a keyed
          // Fragment — keys on the children of an anonymous fragment
          // are not the fragment's key, which is what React was
          // warning about.
          <Fragment key={f.label}>
            <dt>{f.label}</dt>
            <dd className={f.value.length > 120
              ? "asset-facts-long" : undefined}>
              {f.value}
            </dd>
          </Fragment>
        ))}
      </dl>
      {meta?.note !== null && meta?.note !== undefined && (
        <p className="muted asset-facts-note">{meta.note}</p>
      )}
      {probed !== null && (
        <>
          <h4>Technical</h4>
          <dl className="identity-facts">
            {probed.probe.width !== null && (
              <>
                <dt>resolution</dt>
                <dd>
                  {probed.probe.width}
                  {probed.probe.height !== null ? ` × ${probed.probe.height}` : ""}
                </dd>
              </>
            )}
            {probed.probe.durationSecs !== null && (
              <>
                <dt>duration</dt>
                <dd>{humanDuration(probed.probe.durationSecs)}</dd>
              </>
            )}
            {probed.probe.fps !== null && (
              <>
                <dt>frame rate</dt>
                <dd>{Math.round(probed.probe.fps * 100) / 100} fps</dd>
              </>
            )}
            {probed.probe.videoCodec !== null && (
              <>
                <dt>video codec</dt>
                <dd>{probed.probe.videoCodec}</dd>
              </>
            )}
            {probed.probe.audioCodec !== null && (
              <>
                <dt>audio codec</dt>
                <dd>{probed.probe.audioCodec}</dd>
              </>
            )}
          </dl>
          {VERDICT_NOTE[probed.verdict] !== null && (
            <p className="muted asset-facts-note">{VERDICT_NOTE[probed.verdict]}</p>
          )}
          {(probed.verdict === "remux" || probed.verdict === "transcode") && (
            <div className="asset-facts-convert">
              {convert.kind === "idle" && (
                <button className="ghost tiny" onClick={startConvert}>
                  Convert for preview
                </button>
              )}
              {convert.kind === "starting" && (
                <p className="muted small">Starting…</p>
              )}
              {convert.kind === "polling" && (
                <div className="settings-row">
                  <p className="muted small">
                    {convert.status.state === "running" && convert.status.progress !== null
                      ? `Converting… ${String(Math.round(convert.status.progress * 100))}%`
                      : convert.status.state === "running" ? "Converting…" : "Queued…"}
                  </p>
                  <button className="ghost tiny" onClick={cancelConvert}>Cancel</button>
                </div>
              )}
              {convert.kind === "done" && (
                <video src={convert.url} controls className="asset-preview-image" />
              )}
              {convert.kind === "error" && (
                <div className="settings-row">
                  <p className="settings-error">{convert.message}</p>
                  <button className="ghost tiny" onClick={startConvert}>Try again</button>
                </div>
              )}
            </div>
          )}
        </>
      )}
      <p className="muted asset-facts-note">
        Read from the file, not stored in this project.
      </p>
    </section>
  );
}
