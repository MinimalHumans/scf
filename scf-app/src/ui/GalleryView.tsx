// SPDX-License-Identifier: Apache-2.0
import {
  useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { exec, useStore } from "../state/store.ts";
import {
  resolveCached, galleryPreviewFor, type GalleryPreview,
} from "../files/thumbnailCache.ts";
import { useFrameUrl } from "./ShotFrame.tsx";
import { useRememberedOptions } from "./useRememberedOptions.ts";
import { step } from "@scf-core/storyboard.ts";
import { parseIdentifier, type Resolution } from "@scf-core/assets.ts";
import { LARGE_FILE_BYTES } from "@scf-core/preview.ts";
import {
  describeUses, FILTER_LABEL, filterItems, loadGallery, presentItems,
  SORT_LABEL, sortItems,
  type GalleryFilter, type GalleryItem, type GallerySort,
} from "@scf-core/gallery.ts";

const OPTIONS_KEY = "scf:gallery-options";

interface GalleryOptions {
  sort: GallerySort;
  filter: GalleryFilter;
  size: "s" | "m" | "l";
  /** Names under the pictures, or only on hover. */
  names: boolean;
  /** Superseded and cut files too. */
  history: boolean;
  /** Pictures and video only; audio, scans and archives are left out. */
  visualOnly: boolean;
  /** Files the folder does not hold, or that would not load, too. */
  missing: boolean;
  /** The random order's seed, so it holds until reshuffled. */
  seed: number;
}

const DEFAULTS: GalleryOptions = {
  sort: "importance", filter: "all", size: "m", names: false,
  history: false, visualOnly: true, missing: false, seed: 1,
};

function withDefaults(saved: unknown): GalleryOptions {
  if (saved === null || typeof saved !== "object") return DEFAULTS;
  return { ...DEFAULTS, ...(saved as Partial<GalleryOptions>) };
}

/** Column widths for S / M / L. */
const COLUMN_PX = { s: 170, m: 250, l: 380 } as const;
/** The grid's row unit: tiles span whole multiples of it. */
const ROW_PX = 6;
const GAP_PX = 12;

const nameOf = (it: GalleryItem): string =>
  String(it.asset["name"] ?? it.asset["identifier"] ?? "file");

/**
 * GalleryView — the project's pictures, for the pleasure of looking.
 *
 * Read-only. Every asset the project holds, as a masonry wall (each
 * picture at its own shape), sorted by importance — how much of the
 * film the subjects it serves are in (`state/gallery.ts`) — or
 * alphabetically, by newest, or at random. Any tile opens a viewer that
 * dims the app and steps with the arrow keys, and says what the file is
 * used for.
 *
 * The wall is a CSS grid with a small row unit; each tile spans as many
 * rows as its picture is tall at the column width. That keeps the
 * sorted order reading left to right, which CSS columns would turn into
 * top to bottom.
 */
export function GalleryView(): JSX.Element {
  const { revision, assetRoot, environmentRevision } = useStore();
  const [opts, setOpts] = useRememberedOptions(OPTIONS_KEY, withDefaults);
  const [all, setAll] = useState<GalleryItem[] | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [colWidth, setColWidth] = useState<number>(COLUMN_PX[opts.size]);

  useEffect(() => {
    let cancelled = false;
    // A project mid-teardown (closing, opening another) has no tables
    // for a tick; that reads as an empty gallery, not a stuck one.
    void loadGallery(exec, opts.history).then((items) => {
      if (!cancelled) setAll(items);
    }).catch((e: unknown) => {
      console.error("gallery: could not read assets", e);
      if (!cancelled) setAll([]);
    });
    return () => { cancelled = true; };
  }, [revision, opts.history]);

  // Whether each file is actually there, resolved once per identifier
  // (the same cache every thumbnail uses), so a missing file never gets
  // a tile at all rather than an empty one.
  const [states, setStates] = useState<Map<number, string>>(new Map());
  // Resolved, but the browser could not load or decode it.
  const [broken, setBroken] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (all === null) return;
    let cancelled = false;
    void Promise.all(all.map(async (it) => {
      const identifier = typeof it.asset["identifier"] === "string"
        ? it.asset["identifier"] : null;
      const r = await resolveCached(assetRoot, identifier, environmentRevision);
      return [Number(it.asset["id"]), r.state] as const;
    })).then((pairs) => {
      if (!cancelled) setStates(new Map(pairs));
    });
    return () => { cancelled = true; };
  }, [all, assetRoot, environmentRevision]);
  // A new folder is a fresh chance for a file to load.
  useEffect(() => { setBroken(new Set()); }, [assetRoot, environmentRevision]);
  const markBroken = (id: number): void => setBroken((prev) =>
    prev.has(id) ? prev : new Set(prev).add(id));

  const filtered = useMemo(
    () => filterItems(all ?? [], opts.filter, opts.visualOnly),
    [all, opts.filter, opts.visualOnly]);
  const items = useMemo(
    () => sortItems(presentItems(filtered, states, broken, opts.missing),
                    opts.sort, opts.seed),
    [filtered, states, broken, opts.missing, opts.sort, opts.seed]);
  const resolving = all !== null && states.size < all.length;
  const absent = resolving ? 0
    : filtered.length - presentItems(filtered, states, broken, false).length;

  // The real column width, which the auto-fill grid decides.
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (el === null) return;
    const measure = (): void => {
      const cols = getComputedStyle(el).gridTemplateColumns.split(" ").length;
      const w = (el.clientWidth - GAP_PX * (cols - 1)) / Math.max(1, cols);
      if (w > 0) setColWidth(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [opts.size, items.length]);

  const hidden = (all?.length ?? 0) - filterItems(all ?? [], "all", opts.visualOnly).length;

  return (
    <div className="gallery">
      <div className="sl-controls gl-controls">
        <div className="sl-controls-row">
          <div className="sb-seg" role="group" aria-label="Sort">
            {(Object.keys(SORT_LABEL) as GallerySort[]).map((s) => (
              <button key={s} aria-pressed={opts.sort === s}
                      className={opts.sort === s ? "on" : ""}
                      title={s === "importance"
                        ? "Most used first: each subject an asset serves counts " +
                          "for how many scenes it is in"
                        : undefined}
                      onClick={() => setOpts(s === "random" && opts.sort === "random"
                        ? { seed: opts.seed + 1 } : { sort: s })}>
                {SORT_LABEL[s]}
              </button>
            ))}
          </div>
          {opts.sort === "random" && (
            <button className="ghost tiny" title="Shuffle again"
                    onClick={() => setOpts({ seed: opts.seed + 1 })}>
              ⟳ Shuffle
            </button>
          )}
          <label className="sl-field">
            <span>Show</span>
            <select value={opts.filter}
                    onChange={(e) => setOpts({ filter: e.target.value as GalleryFilter })}>
              {(Object.keys(FILTER_LABEL) as GalleryFilter[]).map((f) => (
                <option key={f} value={f}>{FILTER_LABEL[f]}</option>
              ))}
            </select>
          </label>
          <div className="sb-seg" role="group" aria-label="Tile size">
            {(["s", "m", "l"] as const).map((z) => (
              <button key={z} aria-pressed={opts.size === z}
                      className={opts.size === z ? "on" : ""}
                      onClick={() => setOpts({ size: z })}>
                {z.toUpperCase()}
              </button>
            ))}
          </div>
          <button className="primary sl-print" disabled={items.length === 0}
                  onClick={() => setViewing(0)}
                  title="Step through them large. Arrow keys move, Esc closes.">
            ▶ Present
          </button>
        </div>
        <div className="sl-controls-row">
          <label className="sl-check">
            <input type="checkbox" checked={opts.names}
                   onChange={(e) => setOpts({ names: e.target.checked })} />
            Names
          </label>
          <label className="sl-check"
                 title="Audio, 3D scans, archives and other files with no picture">
            <input type="checkbox" checked={!opts.visualOnly}
                   onChange={(e) => setOpts({ visualOnly: !e.target.checked })} />
            Other files{opts.visualOnly && hidden > 0 ? ` (${String(hidden)})` : ""}
          </label>
          <label className="sl-check"
                 title="Files the project folder does not hold, or that would not load">
            <input type="checkbox" checked={opts.missing}
                   onChange={(e) => setOpts({ missing: e.target.checked })} />
            Missing files{absent > 0 ? ` (${String(absent)})` : ""}
          </label>
          <label className="sl-check" title="Superseded and cut files">
            <input type="checkbox" checked={opts.history}
                   onChange={(e) => setOpts({ history: e.target.checked })} />
            Older versions
          </label>
          <span className="muted gl-count">
            {all === null || (resolving && !opts.missing) ? "Reading…"
              : `${String(items.length)} file${items.length === 1 ? "" : "s"}`}
          </span>
        </div>
      </div>

      {all !== null && assetRoot === null && (
        <p className="muted gl-note">
          No project folder is attached, so no file can be found to show.
          Attach the folder from the top bar.
        </p>
      )}

      {all !== null && !resolving && items.length === 0 ? (
        <p className="muted sl-empty">
          {all.length === 0
            ? "No assets in this project yet. Add reference files to " +
              "characters, locations, props or shots and they gather here."
            : absent > 0
              ? "None of these files could be found" +
                (assetRoot === null ? "" : " in the project folder") +
                ". “Missing files” shows where they would be."
              : "Nothing matches. Try “Everything”, or include other files."}
        </p>
      ) : (
        <div ref={gridRef} className={"gl-grid" + (opts.names ? " gl-named" : "")}
             style={{
               gridTemplateColumns:
                 `repeat(auto-fill, minmax(${String(COLUMN_PX[opts.size])}px, 1fr))`,
               gridAutoRows: `${String(ROW_PX)}px`,
               columnGap: `${String(GAP_PX)}px`,
             }}>
          {items.map((it, i) => (
            <Tile key={String(it.asset["id"])} item={it} colWidth={colWidth}
                  size={opts.size}
                  names={opts.names} onOpen={() => setViewing(i)}
                  missing={states.get(Number(it.asset["id"])) !== "resolved" ||
                           broken.has(Number(it.asset["id"]))}
                  onBroken={() => markBroken(Number(it.asset["id"]))} />
          ))}
        </div>
      )}

      {viewing !== null && items.length > 0 && (
        <Viewer items={items} index={Math.min(viewing, items.length - 1)}
                onIndex={setViewing} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}

/** Load only once on screen: a gallery can hold hundreds of plates. */
function useOnScreen<T extends Element>(): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el === null || seen) return;
    if (typeof IntersectionObserver !== "function") { setSeen(true); return; }
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

function Tile({ item, colWidth, names, size, onOpen, missing, onBroken }: {
  item: GalleryItem; colWidth: number; names: boolean;
  /** The gallery's column tier, so the generated preview matches it. */
  size: "s" | "m" | "l";
  onOpen: () => void;
  /** Shown only when missing files are asked for: marked as such. */
  missing: boolean;
  /** The file resolved but would not load or decode. */
  onBroken: () => void;
}): JSX.Element {
  const { assetRoot, environmentRevision } = useStore();
  const root = assetRoot;
  const [ref, seen] = useOnScreen<HTMLButtonElement>();
  const identifier = typeof item.asset["identifier"] === "string"
    ? item.asset["identifier"] : null;
  const parsed = identifier === null ? null : parseIdentifier(identifier);
  const isImage = item.kind === "image";
  const isVideo = item.kind === "video";
  const visual = isImage || isVideo;

  // Images: a small, cached, aspect-preserving preview — the same
  // persistent-raster approach as `AssetThumb`, not a read of the
  // whole file. A gallery can hold hundreds of plates on screen across
  // a scroll session, and re-reading each one in full on every mount
  // is what made this view lag.
  const [resolution, setResolution] = useState<Resolution | null>(null);
  useEffect(() => {
    if (!seen || identifier === null || !isImage) return;
    let cancelled = false;
    void resolveCached(root, identifier, environmentRevision).then((r) => {
      if (!cancelled) setResolution(r);
    });
    return () => { cancelled = true; };
  }, [seen, identifier, root, environmentRevision, isImage]);

  const drawable = isImage && resolution?.state === "resolved" &&
    (resolution.sizeBytes ?? 0) <= LARGE_FILE_BYTES;

  const [preview, setPreview] = useState<GalleryPreview | null>(null);
  // Separate from `preview === null`, which is also true while
  // generation is still in flight — without this, the format chip
  // (meant for "nothing to show") flashed on every image for as long
  // as the read-and-downscale took, instead of only on genuine failure.
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => {
    setPreview(null);
    setPreviewFailed(false);
    if (!drawable || parsed === null || resolution === null) return;
    let cancelled = false;
    void galleryPreviewFor(root, parsed.path, resolution, size).then((p) => {
      if (cancelled) return;
      if (p === null) { setPreviewFailed(true); onBroken(); return; }
      setPreview(p);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawable, parsed?.path, root, resolution, size]);

  // True while an image is known to be on its way but isn't drawn yet:
  // still resolving, or resolved and drawable but not yet generated.
  // The chip is for "nothing will ever be shown here", not "not yet".
  const imagePending = isImage && !previewFailed &&
    (resolution === null || (drawable && preview === null));

  // Video has no cheap client-side downscale (no decoder short of
  // reading the file), so it keeps the full-file path for now — see
  // docs/media-server-spec.md's thumbnail profile for the real fix.
  const videoUrl = useFrameUrl(seen && isVideo ? identifier : null, ["video"]);

  // Until a picture says its shape, assume 4:3.
  const [aspect, setAspect] = useState(4 / 3);
  useEffect(() => {
    if (preview !== null) setAspect(preview.width / preview.height);
  }, [preview]);

  const shown = visual ? aspect : 2;
  const caption = names ? 22 : 0;
  const span = Math.ceil((colWidth / shown + caption + GAP_PX) / ROW_PX);
  const name = nameOf(item);

  return (
    <button ref={ref} className={`gl-tile gl-${item.kind ?? "file"}` +
                                 (missing ? " gl-missing" : "")}
            style={{ gridRowEnd: `span ${String(span)}` }}
            onClick={onOpen}
            title={`${name}\n${describeUses(item.uses).join("\n") || "Not used by anything"}`}>
      <div className="gl-pic" style={{ aspectRatio: String(shown) }}>
        {preview !== null && isImage && (
          <img src={preview.dataUrl} alt={name} decoding="async"
               onError={onBroken} />
        )}
        {videoUrl !== null && isVideo && (
          <video src={videoUrl} muted loop playsInline preload="metadata"
                 onError={onBroken}
                 onLoadedMetadata={(e) => {
                   const v = e.currentTarget;
                   if (v.videoWidth > 0) setAspect(v.videoWidth / v.videoHeight);
                 }}
                 onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
                 onMouseLeave={(e) => e.currentTarget.pause()} />
        )}
        {preview === null && videoUrl === null && !imagePending && (
          <span className="gl-chip">
            {(String(identifier ?? name).split(".").pop() ?? "").slice(0, 5)}
          </span>
        )}
        {item.kind === "video" && <span className="gl-badge">▶</span>}
        {missing && <span className="gl-badge gl-badge-missing">missing</span>}
        {!names && <span className="gl-hover-name">{name}</span>}
      </div>
      {names && <span className="gl-name">{name}</span>}
    </button>
  );
}

function Viewer({ items, index, onIndex, onClose }: {
  items: GalleryItem[]; index: number;
  onIndex: (i: number) => void; onClose: () => void;
}): JSX.Element {
  const item = items[index]!;
  const count = items.length;
  const identifier = typeof item.asset["identifier"] === "string"
    ? item.asset["identifier"] : null;
  const url = useFrameUrl(identifier, ["image", "video"]);
  // The neighbours, so the next step is already loaded.
  useFrameUrl(typeof items[index + 1]?.asset["identifier"] === "string"
    ? items[index + 1]!.asset["identifier"] as string : null);
  useFrameUrl(typeof items[index - 1]?.asset["identifier"] === "string"
    ? items[index - 1]!.asset["identifier"] as string : null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const go = (i: number): void => { e.preventDefault(); onIndex(i); };
      switch (e.key) {
        case "ArrowRight": case "ArrowDown": case "PageDown": case " ":
          go(step(index, 1, count)); break;
        case "ArrowLeft": case "ArrowUp": case "PageUp":
          go(step(index, -1, count)); break;
        case "Home": go(0); break;
        case "End": go(count - 1); break;
        case "Escape":
          if (document.fullscreenElement === null) { e.preventDefault(); onClose(); }
          break;
        case "f": case "F":
          e.preventDefault();
          if (document.fullscreenElement === null) {
            void document.documentElement.requestFullscreen?.().catch(() => {});
          } else {
            void document.exitFullscreen();
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, count, onIndex, onClose]);
  useEffect(() => () => {
    if (document.fullscreenElement !== null) void document.exitFullscreen();
  }, []);

  const name = nameOf(item);
  const description = String(item.asset["description"] ?? "").trim();
  const uses = describeUses(item.uses);

  return createPortal(
    <div className="sb-lightbox gl-viewer" role="dialog" aria-modal="true"
         aria-label={`${name}, ${String(index + 1)} of ${String(count)}`}
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sb-lb-top">
        <span className="sb-lb-scene">{name}</span>
        <span className="sb-lb-count">{index + 1} / {count}</span>
        <button className="ghost" onClick={onClose} aria-label="Close"
                title="Close (Esc)">×</button>
      </div>
      <button className="sb-lb-nav" aria-label="Previous" disabled={index === 0}
              onClick={() => onIndex(step(index, -1, count))}>‹</button>
      <div className="sb-lb-stage gl-stage"
           onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        {url !== null && item.kind === "image" && <img src={url} alt={name} />}
        {url !== null && item.kind === "video" &&
          <video key={url} src={url} controls autoPlay muted loop playsInline />}
        {url === null && (
          <div className="gl-viewer-empty">
            <strong>{(String(identifier ?? name).split(".").pop() ?? "").toUpperCase()}</strong>
            <span>{identifier ?? "no identifier"}</span>
          </div>
        )}
      </div>
      <button className="sb-lb-nav" aria-label="Next" disabled={index === count - 1}
              onClick={() => onIndex(step(index, 1, count))}>›</button>
      <div className="sb-lb-caption">
        {description !== "" && <p>{description}</p>}
        <p className="gl-uses">
          {uses.length === 0 ? "Not used by anything yet." : uses.join(" · ")}
        </p>
        <p className="sb-lb-keys">← → step · F full screen · Esc close</p>
      </div>
    </div>,
    document.body);
}
