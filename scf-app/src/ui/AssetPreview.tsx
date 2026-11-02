// SPDX-License-Identifier: Apache-2.0
/**
 * AssetPreview — showing the bytes an identifier points at (P5).
 *
 * Tier 1 always renders: an object URL into an <img>, <video>,
 * <audio>, <iframe> for pdf, or truncated text. Tier 3 (`named`) says
 * what it is and why, because "cannot display" is a real answer and
 * dressing it up as an error would be wrong about nearly half a real
 * project.
 *
 * Tier 2 (`decoded`) used to always say the same thing: a fixed "needs
 * a decoder the browser does not have" sentence, dead-ended, no matter
 * what was actually installed. Phase 5 changes that for the still
 * formats `STILL_BACKEND` names (EXR/TIFF/PSD/HEIC/DPX): it asks
 * `/meta` whether a real backend (oiiotool/magick) is configured, and
 * if so requests the rendered result from `/media` the same way tier 1
 * does — unlike Phase 4's video Convert button (deliberately kept out
 * of this component, proven instead through `AssetFileFacts.tsx`),
 * because a still render has no "accidentally expensive" risk to gate
 * behind an explicit click, and because an EXR's layer picker directly
 * controls what this pane shows, which only this component can do.
 * Every other `decoded`-tier format (`.mov`, `.glb`, `.usd`, ...) is
 * untouched — still the same static sentence, still no network call.
 *
 * Nothing is cached and nothing is written. Object URLs are revoked on
 * unmount and when the identifier changes; a browser that keeps one
 * alive keeps the whole file in memory, and an asset browser walked
 * through a few hundred plates would hold all of them.
 */

import { useEffect, useState } from "react";
import {
  previewCapability, LARGE_FILE_BYTES, STILL_BACKEND, TEXT_PREVIEW_LIMIT,
  type PreviewCapability,
} from "@scf-core/preview.ts";
import { parseIdentifier, resolveIdentifier, type Resolution }
  from "@scf-core/assets.ts";
import {
  acquire, acquireMeta, jobStatus, release, requestStillRender,
  type JobStatus,
} from "../files/objectUrlCache.ts";
import { makeLocator, readAssetText }
  from "../files/assetLocator.ts";
import { useStore } from "../state/store.ts";

/** How often a queued/running still render is polled — same cadence
 *  `AssetFileFacts.tsx`'s video Convert button uses. */
const POLL_MS = 750;

type StillRenderState =
  | { kind: "idle" }
  | { kind: "probing" }
  | { kind: "ready"; url: string }
  | { kind: "queued"; jobId: string; status: JobStatus | null }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

function Unavailable({ cap, state }: {
  cap: PreviewCapability; state: string;
}): JSX.Element {
  return (
    <div className="asset-preview asset-preview-none">
      <p className="muted">
        {state !== "resolved"
          ? "Nothing to show until this resolves."
          : cap.detail}
      </p>
    </div>
  );
}

export function AssetPreview({ identifier }: {
  identifier: string | null;
}): JSX.Element | null {
  const { assetRoot } = useStore();
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const [stillRender, setStillRender] = useState<StillRenderState>({ kind: "idle" });
  const [layers, setLayers] = useState<string[]>([]);
  const [channels, setChannels] = useState<string[]>([]);
  const [selectedLayer, setSelectedLayer] = useState("");
  const [selectedChannel, setSelectedChannel] = useState("");
  // Sticky across assets: someone checking a cycle or a loop-point is
  // usually checking several in a row, and re-ticking it every time
  // would be its own small annoyance. Applies to audio too — a footstep
  // or a room tone is exactly the kind of thing you listen to round.
  const [loop, setLoop] = useState(() =>
    localStorage.getItem("scf:preview-loop") === "1");

  const setLooping = (on: boolean): void => {
    setLoop(on);
    localStorage.setItem("scf:preview-loop", on ? "1" : "0");
  };

  const root = assetRoot;

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setText(null);
    setAsked(false);
    setStillRender({ kind: "idle" });
    setLayers([]);
    setChannels([]);
    setSelectedLayer("");
    setSelectedChannel("");
    void (async () => {
      const r = await resolveIdentifier(identifier, makeLocator(root));
      if (!cancelled) setResolution(r);
    })();
    return () => { cancelled = true; };
  }, [identifier, root]);

  const cap = previewCapability(resolution?.format ?? null);
  const parsed = identifier === null ? null : parseIdentifier(identifier);
  const big = (resolution?.sizeBytes ?? 0) > LARGE_FILE_BYTES;
  const isStill = cap.tier === "decoded" &&
    STILL_BACKEND.includes((resolution?.format ?? "").toLowerCase());

  // Load only when it can be shown, and only when a large file has been
  // asked for: opening an asset row should never pull 200MB off disk on
  // its own.
  // The URL comes from the shared refcounted cache rather than being
  // created and revoked here. Two reasons: stepping back and forth
  // between two assets otherwise re-reads both every time, and an
  // instance owning its URL outright cannot bound how many files an
  // asset browser holds at once.
  useEffect(() => {
    let cancelled = false;
    let held: string | null = null;

    void (async () => {
      if (resolution?.state !== "resolved") return;
      if (cap.tier !== "native" || parsed === null) return;
      if (big && !asked) return;

      if (cap.kind === "text") {
        const body = await readAssetText(root, parsed.path,
                                         TEXT_PREVIEW_LIMIT);
        if (!cancelled) setText(body);
        return;
      }
      held = parsed.path;
      const objectUrl = await acquire(root, parsed.path);
      if (cancelled) return;
      setUrl(objectUrl);
    })();

    return () => {
      cancelled = true;
      if (held !== null) release(root, held);
    };
  }, [resolution, cap.tier, cap.kind, parsed?.path, root, big, asked]);

  // The still-image counterpart (Phase 5): probe for a layer/channel
  // list and a verdict, then request the render, polling while it's
  // queued. Re-runs whenever the chosen layer/channel changes — a
  // different layer is a different cache key server-side, not a
  // client-side crop of the same image.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    void (async () => {
      if (resolution?.state !== "resolved" || !isStill || parsed === null) return;
      if (big && !asked) return;

      setStillRender({ kind: "probing" });
      const meta = await acquireMeta(root, parsed.path);
      if (cancelled) return;
      if (meta === null || meta.verdict !== "render") {
        setStillRender({ kind: "unavailable" });
        return;
      }
      setLayers(meta.layers);
      setChannels(meta.channels);

      const request = async (): Promise<void> => {
        const result = await requestStillRender(
          root, parsed.path, selectedLayer, selectedChannel);
        if (cancelled) return;
        if (result.kind === "ready") {
          setStillRender({ kind: "ready", url: result.url });
        } else if (result.kind === "unsupported") {
          setStillRender({ kind: "unavailable" });
        } else if (result.kind === "error") {
          setStillRender({ kind: "error", message: result.message });
        } else {
          const jobId = result.jobId;
          setStillRender({ kind: "queued", jobId, status: null });
          timer = setInterval(() => {
            void jobStatus(jobId).then((status) => {
              if (cancelled || status === null) return;
              if (status.state === "done") {
                clearInterval(timer);
                void request(); // now a cache hit — picks up the real url
              } else if (status.state === "failed") {
                clearInterval(timer);
                setStillRender({ kind: "error", message: status.error ?? "render failed" });
              } else if (status.state === "cancelled") {
                clearInterval(timer);
                setStillRender({ kind: "idle" });
              } else {
                setStillRender({ kind: "queued", jobId, status });
              }
            });
          }, POLL_MS);
        }
      };
      await request();
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [resolution, isStill, parsed?.path, root, big, asked, selectedLayer, selectedChannel]);

  if (identifier === null || resolution === null) return null;

  if (resolution.state !== "resolved" || (cap.tier !== "native" && !isStill)) {
    return <Unavailable cap={cap} state={resolution.state} />;
  }

  if (big && !asked) {
    return (
      <div className="asset-preview asset-preview-none">
        <p className="muted">
          {Math.round((resolution.sizeBytes ?? 0) / 1024 / 1024)} MB —
          large enough that loading it is worth asking about.
        </p>
        <button className="tiny" onClick={() => setAsked(true)}>
          Load preview
        </button>
      </div>
    );
  }

  if (isStill) {
    return (
      <div className="asset-preview">
        {layers.length > 0 && (
          <div className="asset-preview-layers">
            <select value={selectedLayer} aria-label="Layer"
                    onChange={(e) => { setSelectedLayer(e.target.value); setSelectedChannel(""); }}>
              <option value="">(default layer)</option>
              {layers.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            {channels.length > 0 && (
              <select value={selectedChannel} aria-label="Channel"
                      onChange={(e) => setSelectedChannel(e.target.value)}>
                <option value="">(whole layer)</option>
                {channels.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
          </div>
        )}
        {stillRender.kind === "probing" && <p className="muted">Checking…</p>}
        {stillRender.kind === "queued" && (
          <p className="muted">
            {stillRender.status?.state === "running" ? "Rendering…" : "Queued…"}
          </p>
        )}
        {stillRender.kind === "ready" && (
          <img src={stillRender.url} alt="" className="asset-preview-image" />
        )}
        {stillRender.kind === "unavailable" && <p className="muted">{cap.detail}</p>}
        {stillRender.kind === "error" && (
          <p className="muted">{stillRender.message}</p>
        )}
        {stillRender.kind === "idle" && <p className="muted">Loading…</p>}
      </div>
    );
  }

  if (cap.kind === "text") {
    return (
      <div className="asset-preview">
        {text === null
          ? <p className="muted">Reading…</p>
          : <pre className="asset-preview-text">{text}</pre>}
      </div>
    );
  }

  if (url === null) {
    return (
      <div className="asset-preview asset-preview-none">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return (
    <div className="asset-preview">
      {cap.kind === "image" && (
        <img src={url} alt="" className="asset-preview-image" />
      )}
      {cap.kind === "video" && (
        <video src={url} controls loop={loop}
               className="asset-preview-image" />
      )}
      {cap.kind === "audio" && <audio src={url} controls loop={loop} />}
      {(cap.kind === "video" || cap.kind === "audio") && (
        <label className="asset-preview-loop">
          <input type="checkbox" checked={loop}
                 onChange={(e) => setLooping(e.target.checked)} />
          loop
        </label>
      )}
      {cap.kind === "pdf" && (
        <iframe src={url} className="asset-preview-pdf" title="preview" />
      )}
    </div>
  );
}
