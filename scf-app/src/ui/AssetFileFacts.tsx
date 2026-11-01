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
import { PROBEABLE } from "@scf-core/preview.ts";
import { readAssetBytes } from "../files/assetLocator.ts";
import { acquireMeta, type AssetMeta } from "../files/objectUrlCache.ts";
import { reportMediaCapabilities } from "../state/mediaCapabilities.ts";
import { useStore } from "../state/store.ts";

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

/** One sentence for a verdict that means "the browser can't just play
 *  this" — `null` for `passthrough`, where there's nothing to add. */
const VERDICT_NOTE: Record<AssetMeta["verdict"], string | null> = {
  passthrough: null,
  remux: "the codec is fine, but the container needs rewrapping first — " +
         "not set up yet",
  transcode: "the browser can't decode this — converting it isn't set " +
             "up yet",
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
    if (!PROBEABLE.includes(formatOf(identifier ?? "") ?? "")) return;

    void (async () => {
      await reportMediaCapabilities();
      const result = await acquireMeta(root, parsed.path);
      if (!cancelled) setProbed(result);
    })();

    return () => { cancelled = true; };
  }, [identifier, root]);

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
        </>
      )}
      <p className="muted asset-facts-note">
        Read from the file, not stored in this project.
      </p>
    </section>
  );
}
