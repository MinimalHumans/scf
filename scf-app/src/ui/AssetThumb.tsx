// SPDX-License-Identifier: Apache-2.0
/**
 * AssetThumb — the small one.
 *
 * Deliberately NOT AssetPreview at a smaller size. A previewer is one
 * of a kind on screen and can afford to resolve, read and hold a file
 * the moment it mounts; a thumbnail appears forty at a time in a list
 * nobody has scrolled yet. Three differences follow, and they are the
 * whole reason this is a separate component:
 *
 *  1. Nothing loads until the row is ON SCREEN (IntersectionObserver).
 *     A bundle of two hundred plates that the user never scrolls costs
 *     two hundred resolutions and zero reads.
 *  2. Resolution and the drawn raster both come from `thumbnailCache`,
 *     which survives unmount, tab switches and reload, so the second
 *     visit to the assets tab touches no files at all.
 *  3. Images, and video as a live frame (VideoThumb, below — streamed,
 *     not drawn into the cache); audio and text have no small form at all.
 *     Everything else gets a format chip — the SAME SIZE as an image,
 *     because a slot that collapses for the .zip makes every list jump
 *     as it loads, and three of the nine assets in Hollow Creek are
 *     not natively viewable.
 *
 * The chip is not a failure state. `previewCapability`'s third tier is
 * a real tier: a LoRA is not media, and there is no image of it to fail
 * to render.
 *
 * The CROP lives in the cache, not in CSS. Scaling and offsetting the
 * full image inside a clipping box means holding a whole plate decoded
 * to show 176 pixels of it, and cannot distinguish "no region" from "a
 * region that did not fit" — both render as the whole frame.
 */

import { useEffect, useRef, useState } from "react";
import { previewCapability, LARGE_FILE_BYTES }
  from "@scf-core/preview.ts";
import { parseIdentifier, type Resolution } from "@scf-core/assets.ts";
import type { RegionBox } from "@scf-core/anchors.ts";
import {
  TILE_THUMB_PX, galleryPreviewFor, previewWidthFor, resolveCached,
  thumbnailFor, type Thumbnail,
} from "../files/thumbnailCache.ts";
import { useStore } from "../state/store.ts";
import { acquire, release } from "../files/objectUrlCache.ts";

export type ThumbSize = "sm" | "md" | "lg";

/** Short label for a tier-2/3 asset. The detail goes in the title. */
function chipLabel(format: string | null): string {
  if (format === null) return "?";
  return format.length > 5 ? format.slice(0, 5) : format;
}

export function AssetThumb({ identifier, size = "sm", region = null,
                            alt = "", onClick, onRegion,
                            detail = "slot" }: {
  identifier: string | null;
  size?: ThumbSize;
  /**
   * `slot` (the default) is the small square in a list. `tile` is for a
   * caller whose CSS stretches the thumbnail across a card: the picture
   * is then drawn several times larger than a slot, and the slot's
   * raster stretched that far is soft. A tile gets a preview sized for
   * the box it is drawn in, at the picture's own shape.
   */
  detail?: "slot" | "tile";
  /** Crop to this box, in the asset's own pixels. Applied during
   *  generation, and dropped if it does not fit what loaded. */
  region?: RegionBox | null;
  alt?: string;
  onClick?: () => void;
  /** Told whether the region was actually used, so a caller that asked
   *  for one can report a box that does not fit its asset. */
  onRegion?: (applied: boolean) => void;
}): JSX.Element {
  const { assetRoot, environmentRevision } = useStore();
  const root = assetRoot;
  const box = useRef<HTMLDivElement | null>(null);

  const [visible, setVisible] = useState(false);
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [thumb, setThumb] = useState<Thumbnail | null>(null);

  // On screen? Rendered with a margin so a thumbnail is ready by the
  // time it is scrolled to, rather than popping in after it arrives.
  useEffect(() => {
    const el = box.current;
    if (el === null) return;
    if (typeof IntersectionObserver !== "function") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver((es) => {
      // One-way: once seen, stay loaded. Unloading on scroll-away would
      // re-read the file every time the list moved.
      if (es.some((e) => e.isIntersecting)) {
        setVisible(true);
        io.disconnect();
      }
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Memoised across every thumbnail of the same asset AND across
  // mounts, so a list makes one traversal per distinct identifier on
  // the first visit and none at all on the second. This was the bulk of
  // the lag: `getDirectoryHandle`/`getFileHandle`/`getFile` per row,
  // re-run every time the tab was opened.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void (async () => {
      const r = await resolveCached(root, identifier, environmentRevision);
      if (!cancelled) setResolution(r);
    })();
    return () => { cancelled = true; };
  }, [visible, identifier, root, environmentRevision]);

  const cap = previewCapability(resolution?.format ?? null);
  const parsed = identifier === null ? null : parseIdentifier(identifier);
  const drawable = resolution?.state === "resolved" &&
                   cap.kind === "image" &&
                   (resolution.sizeBytes ?? 0) <= LARGE_FILE_BYTES;

  useEffect(() => {
    if (!drawable || parsed === null || resolution === null) return;
    let cancelled = false;
    void (async () => {
      if (detail === "tile" && region === null) {
        // The whole picture, at its own shape, wide enough for the box
        // it is drawn in. The tile's CSS fits it without cropping.
        const wide = box.current?.clientWidth ?? 0;
        const p = await galleryPreviewFor(
          root, parsed.path, resolution,
          previewWidthFor(wide > 0 ? wide : 256));
        if (cancelled) return;
        setThumb(p === null
          ? null : { dataUrl: p.dataUrl, regionApplied: false });
        return;
      }
      const t = await thumbnailFor(
        root, parsed.path, resolution, region,
        detail === "tile" ? TILE_THUMB_PX : undefined);
      if (cancelled) return;
      setThumb(t);
      if (t !== null) onRegion?.(t.regionApplied);
    })();
    return () => { cancelled = true; };
    // `resolution` is identity-stable per asset because it comes from a
    // memoised promise, so this does not re-run on every render.
  }, [drawable, parsed?.path, root, resolution, region, detail]);

  const cls = `asset-thumb asset-thumb-${size}`;

  if (identifier === null) {
    return (
      <div ref={box} className={`${cls} asset-thumb-chip`}
           title="No identifier, so there is nothing to address.">
        —
      </div>
    );
  }

  if (!visible || resolution === null) {
    return <div ref={box} className={`${cls} asset-thumb-idle`} />;
  }

  if (resolution.state !== "resolved") {
    return (
      <div ref={box} className={`${cls} asset-thumb-chip
                                 asset-thumb-${resolution.state}`}
           title={resolution.detail ??
             (root === null
               ? "No project folder attached, so nothing can resolve."
               : "")}>
        {resolution.state === "unaddressed" ? "—" : "!"}
      </div>
    );
  }

  // A video's poster is a frame of the video itself, streamed rather
  // than read whole, so size is no bar to showing one.
  if (cap.kind === "video" && cap.tier === "native" && parsed !== null) {
    return (
      <div ref={box}
           className={`${cls} asset-thumb-video` +
                      (onClick === undefined ? "" : " asset-thumb-btn")}
           onClick={onClick}
           role={onClick === undefined ? undefined : "button"}
           title={alt}>
        <VideoThumb root={root} path={parsed.path} alt={alt}
                    playOnHover={size !== "sm"} />
      </div>
    );
  }

  if (!drawable) {
    const why = (resolution.sizeBytes ?? 0) > LARGE_FILE_BYTES
      ? `${Math.round((resolution.sizeBytes ?? 0) / 1024 / 1024)} MB — ` +
        `too large to decode for a thumbnail. Open the asset to load it.`
      : cap.detail ?? "";
    return (
      <div ref={box} className={`${cls} asset-thumb-chip`} title={why}>
        {chipLabel(resolution.format)}
      </div>
    );
  }

  return (
    <div ref={box}
         className={`${cls}${onClick === undefined ? "" : " asset-thumb-btn"}`}
         onClick={onClick}
         role={onClick === undefined ? undefined : "button"}
         title={alt}>
      {thumb !== null && (
        <img src={thumb.dataUrl} alt={alt} className="asset-thumb-img" />
      )}
    </div>
  );
}

/**
 * A video thumbnail: the file streamed into a muted <video>, parked on
 * a frame a little way in (the first is often black), and played while
 * the pointer is over it where the thumbnail is big enough to watch.
 *
 * The URL comes from the shared refcounted cache, like a previewer's:
 * it is a reference to the file, not a copy, and `preload="metadata"`
 * reads only what is needed to show one frame until it plays.
 */
function VideoThumb({ root, path, alt, playOnHover }: {
  root: string | null;
  path: string;
  alt: string;
  playOnHover: boolean;
}): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const poster = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const u = await acquire(root, path);
      if (!cancelled) setUrl(u);
    })();
    return () => {
      cancelled = true;
      release(root, path);
    };
  }, [root, path]);

  if (failed || url === null) {
    return <span className="asset-thumb-video-chip">{failed ? "!" : ""}</span>;
  }
  return (
    <>
      <video className="asset-thumb-img" src={url} muted loop playsInline
             preload="metadata" aria-label={alt}
             onLoadedMetadata={(e) => {
               const v = e.currentTarget;
               poster.current = Number.isFinite(v.duration)
                 ? Math.min(1, v.duration / 10) : 0;
               v.currentTime = poster.current;
             }}
             onError={() => setFailed(true)}
             onMouseEnter={playOnHover ? (e) => {
               void e.currentTarget.play().catch(() => {});
             } : undefined}
             onMouseLeave={playOnHover ? (e) => {
               const v = e.currentTarget;
               v.pause();
               v.currentTime = poster.current;
             } : undefined} />
      <span className="asset-thumb-play" aria-hidden="true">▶</span>
    </>
  );
}
