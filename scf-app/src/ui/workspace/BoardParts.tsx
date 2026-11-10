// SPDX-License-Identifier: Apache-2.0
/**
 * BoardParts.tsx — the pieces a reference board and its exception cards
 * share: how files arrive, a tile, and what is in force "as of" a scene.
 */
import { call } from "../../state/api.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ImportCandidate } from "@scf-core/assetImport.ts";
import { resolveMedia } from "@scf-core/resolution.ts";
import { exec, registry, useStore } from "../../state/store.ts";
import {
  BOARDS, purposeLabel, SharedSetError, withCreatedAssets, type BoardName,
  type Owner, type Purpose, type Tile,
} from "@scf-core/ops/mediaOps.ts";
import type { ChangeUndo } from "@scf-core/ops/undoChange.ts";
import { addressPaths } from "../../files/dropIntake.ts";
import { pickAssetFiles } from "../../files/assetPicker.ts";
import { registerDropZone } from "../../files/nativeDrop.ts";
import { AssetThumb } from "../AssetThumb.tsx";
import { scopeSummary } from "./AnchorScope.tsx";
import { useQuery } from "../useQuery.ts";
import { StandingTag } from "../StandingTag.tsx";
import type { Standing } from "@scf-core/assetStanding.ts";

/** Files on their way onto a board or an exception. */
export interface Incoming {
  /** New to the project: become asset rows when placed. */
  candidates: ImportCandidate[];
  /** Already assets in the project. */
  assetIds: number[];
  names: string[];
}

export const fail = (what: string, e: unknown): void =>
  useStore.setState({ errorMessage: `${what}: ${
    e instanceof Error ? e.message : String(e)}` });

/** What is in force for an owner at the "as of" scene, when one is set. */
export interface InForce {
  /** Files the bindings put in force (set tiles). */
  assetIds: Set<number>;
  /** Anchors in force (identity tiles), by anchor row id — not by file:
   *  one file can be a set member and a candidate anchor at once, and
   *  only one of those may apply. */
  anchorIds: Set<number>;
  /** binding id → applies. */
  bindings: Map<number, boolean>;
}

export function useInForce(owner: Owner, board: BoardName): InForce | null {
  const { asOfSceneId, revision } = useStore();
  const [result, setResult] = useState<InForce | null>(null);
  useEffect(() => {
    if (asOfSceneId === null) { setResult(null); return; }
    let cancelled = false;
    // The same resolution Q13 runs — the workspace never computes its
    // own version of "what applies here".
    void resolveMedia({ exec, registry }, owner.kind, owner.id,
                      BOARDS[board].intent, asOfSceneId).then((m) => {
      if (cancelled) return;
      const ids = new Set<number>();
      for (const a of m.assets_most_specific_first) ids.add(Number(a["id"]));
      setResult({ assetIds: ids,
                  anchorIds: new Set(m.anchors.map((a) => Number(a["id"]))),
                  bindings: new Map(m.binding_verdicts.map((v) =>
                    [v.id, v.applies])) });
    }).catch(() => { if (!cancelled) setResult(null); });
    return () => { cancelled = true; };
  }, [owner.kind, owner.id, board, asOfSceneId, revision]);
  return result;
}

/**
 * The ways files arrive: dropped from the project folder, picked, or
 * chosen from what the project already holds. Hands them on as one
 * Incoming; what they are for is the caller's question.
 */
export function FileIntake({ onFiles, compact = false, exclude }: {
  onFiles: (incoming: Incoming) => void;
  compact?: boolean;
  exclude?: Set<number>;
}): JSX.Element {
  const { assetRoot, attachFolder } = useStore();
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const dropRef = useRef<HTMLDivElement | null>(null);
  const root = assetRoot;

  const receive = (candidates: ImportCandidate[], outside: string[],
                   folders: string[]): void => {
    const notes: string[] = [];
    if (outside.length > 0) {
      notes.push(`${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} ` +
        "outside the project folder, so there is no address to point at. " +
        "Move the file into the folder, then drop it again.");
    }
    if (folders.length > 0) {
      notes.push(`Folders are not taken here (${folders.join(", ")}); ` +
                 "drop the files inside them.");
    }
    setNotice(notes.length === 0 ? null : notes.join(" "));
    if (candidates.length > 0) {
      onFiles({ candidates, assetIds: [],
                names: candidates.map((c) => c.name ?? c.identifier) });
    }
  };

  // The shell reports one drag state for the whole window, not per
  // element (nativeDrop.ts), so this zone is only told about drags
  // over its own bounds, and only acts when a root is attached.
  useEffect(() => registerDropZone({
    element: () => dropRef.current,
    onOver: (over) => { setDragging(root !== null && over); },
    onDrop: (paths) => {
      setDragging(false);
      if (root === null) return;
      void addressPaths(root, paths).then((intake) =>
        receive(intake.candidates, intake.outside, intake.folders))
        .catch((err: unknown) => fail("Could not read the drop", err));
    },
  }), [root]);

  return (
    <>
      <div ref={dropRef}
           className={"board-drop" + (dragging ? " over" : "") +
                      (root === null ? " closed" : "") +
                      (compact ? " compact" : "")}>
        {root === null ? (
          <p>
            {compact ? "" : "Attach the project folder to drop files here. "}
            <button className="ghost tiny"
                    onClick={() => void attachFolder()}>
              Connect folder
            </button>
          </p>
        ) : (
          <p>
            {compact ? "Drop files here, or " :
              "Drop files from the project folder here, or "}
            <button className="ghost tiny" onClick={() => {
              void pickAssetFiles(root).then((picked) => {
                if (picked !== null) {
                  receive(picked.candidates, picked.outsideRoot, []);
                }
              }).catch((e: unknown) => fail("Could not pick files", e));
            }}>choose files</button>.
          </p>
        )}
        <button className="ghost tiny" onClick={() => setChoosing((v) => !v)}
                aria-expanded={choosing}>
          Use files already in the project
        </button>
      </div>
      {notice !== null && <p className="board-notice" role="alert">{notice}</p>}
      {choosing && (
        <AssetChooser exclude={exclude ?? new Set()}
                      onCancel={() => setChoosing(false)}
                      onChoose={(ids, names) => {
                        setChoosing(false);
                        onFiles({ candidates: [], assetIds: ids, names });
                      }} />
      )}
    </>
  );
}

/** Register new files, then attach everything; one undo for both. */
export async function placeFiles(
    incoming: Incoming, owner: Owner, board: BoardName, purpose: Purpose,
    options: { role?: string; shared?: "both" | "split"; bundleId?: number },
): Promise<ChangeUndo> {
  const { assetIds, created } = await call(
    "media.registerFiles", incoming.candidates);
  try {
    const change = await call("media.attach", owner, board,
                                [...incoming.assetIds, ...assetIds], purpose,
                                options);
    return withCreatedAssets(change, created);
  } catch (e) {
    if (e instanceof SharedSetError) {
      // The asset rows are kept: they are the same files whichever way
      // the writer answers, and the retry finds them by identifier.
      throw Object.assign(e, { assetIds: [...incoming.assetIds, ...assetIds] });
    }
    throw e;
  }
}

/** Boards whose identity tiles can say which part of the file is meant. */
const SCOPED: Partial<Record<BoardName, "region" | "clip">> = {
  look: "region", voice: "clip", sound: "clip",
};

export function BoardTile({ tile, board, owner, purposes, live, onChange,
                            onOpen, onScope, scoping = false, standing,
                            reorder }: {
  tile: Tile; board: BoardName; owner: Owner; purposes: Purpose[];
  /** Current or history (assetStanding.ts); absent where not shown. */
  standing?: Standing;
  /** Present on tiles whose link carries an order; a missing side
   *  means there is nothing that way to trade places with. */
  reorder?: { earlier?: (() => void) | undefined;
              later?: (() => void) | undefined } | undefined;
  /** True or false when an "as of" scene is set; null otherwise. */
  live: boolean | null;
  onChange: (c: ChangeUndo) => void; onOpen: () => void;
  /** Open the region or clip editor for this tile; absent where the
   *  board does not offer it. */
  onScope?: () => void;
  scoping?: boolean;
}): JSX.Element {
  const scopeKind = tile.purpose === "identity" ? SCOPED[board] : undefined;
  const summary = scopeKind === undefined ? null
    : scopeSummary(tile, scopeKind === "clip");
  // A new object every read; the thumbnail keys its work on identity.
  const regionKey = JSON.stringify(tile.scope?.region ?? null);
  const region = useMemo(() => tile.scope?.region ?? null,
                         [regionKey]);  // eslint-disable-line react-hooks/exhaustive-deps
  const [role, setRole] = useState(tile.role ?? "");
  useEffect(() => { setRole(tile.role ?? ""); }, [tile.role]);
  const identifier = tile.asset["identifier"];
  const name = String(tile.asset["name"] ?? identifier ?? "file");
  const run = (p: Promise<ChangeUndo>, what: string): void => {
    p.then(onChange).catch((e: unknown) => fail(what, e));
  };
  const primary = tile.purpose === "identity" && tile.status === "verified" &&
    tile.variant === null;
  const history = standing?.historic === true ? standing : null;
  const successorId = tile.asset["superseded_by_id"];

  return (
    <li className={"board-tile" + (primary ? " primary" : "") +
                   (live === false ? " dim" : "") +
                   (history !== null
                     ? ` board-tile-historic board-tile-${history.kind}` : "")}>
      <div className="board-thumb">
        <AssetThumb identifier={typeof identifier === "string" ? identifier : null}
                    size="lg" detail="tile" alt={name} onClick={onOpen}
                    region={scopeKind === "region" ? region : null} />
        {primary && <span className="board-star" title="The reference">★</span>}
        {live === true && <span className="board-live">in force</span>}
      </div>
      <div className="board-tile-meta">
        <span className="board-tile-name" title={String(identifier ?? "")}>{name}</span>
        {history !== null && (
          <StandingTag standing={history}
                       onOpenSuccessor={successorId === null ||
                         successorId === undefined ? undefined
                         : () => void useStore.getState().openEntityRow(
                             "asset", Number(successorId))} />
        )}
        {tile.variant !== null && (
          <span className="ws-chip ws-chip-variant">{tile.variant}</span>
        )}
        {tile.link.entity !== "bundle_asset" || purposes.length > 1 ? (
          <>
            <label className="visually-hidden" htmlFor={`p-${tile.key}`}>
              What {name} is for
            </label>
            <select id={`p-${tile.key}`} value={tile.purpose}
                    disabled={tile.variant !== null}
                    title={tile.variant !== null
                      ? "A variant's reference: edit it in Schema for now"
                      : undefined}
                    onChange={(e) => {
                      run(call("media.repurpose", owner, board, tile,
                                    e.target.value as Purpose),
                          "Could not change what it is for");
                    }}>
              {tile.purpose === "other" &&
                <option value="other">{tile.label}</option>}
              {purposes.map((p) => (
                <option key={p} value={p}>{purposeLabel(owner.kind, board, p)}</option>
              ))}
            </select>
          </>
        ) : null}
        {tile.purpose === "set" && (
          <input aria-label={`Role of ${name}`} value={role}
                 placeholder="front, side, turnaround…"
                 onChange={(e) => setRole(e.target.value)}
                 onBlur={() => {
                   if (role.trim() === (tile.role ?? "")) return;
                   run(call("media.setTileRole", tile.link.id, role),
                       "Could not set the role");
                 }}
                 onKeyDown={(e) => {
                   if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                 }} />
        )}
        {tile.purpose === "identity" && tile.status !== "verified" && (
          <button className="tiny"
                  title="Proposed, not yet confirmed. Tools ignore it until it is."
                  onClick={() => run(call("media.confirmIdentity", tile.link.id),
                                     "Could not confirm")}>
            Confirm ({tile.status ?? "unconfirmed"})
          </button>
        )}
        {scopeKind !== undefined && onScope !== undefined && (
          <button className={"tiny scope-open" + (summary !== null ? " set" : "")}
                  aria-expanded={scoping} onClick={onScope}
                  title={scopeKind === "region"
                    ? "Mark which part of the image is meant"
                    : "Mark which stretch of the recording is meant"}>
            {scopeKind === "region"
              ? summary === null
                ? owner.kind === "character" ? "Mark the face" : "Mark a region"
                : `Region: ${summary}`
              : summary === null ? "Mark the clip" : `Clip ${summary}`}
          </button>
        )}
        <div className="ws-row-actions">
          {reorder !== undefined && (
            <>
              <button className="ghost tiny" title="Earlier"
                      aria-label={`Move ${name} earlier`}
                      disabled={reorder.earlier === undefined}
                      onClick={reorder.earlier}>◀</button>
              <button className="ghost tiny" title="Later"
                      aria-label={`Move ${name} later`}
                      disabled={reorder.later === undefined}
                      onClick={reorder.later}>▶</button>
            </>
          )}
          <button className="ghost tiny" onClick={onOpen}>Show in Assets</button>
          <button className="ghost tiny"
                  onClick={() => run(call("media.detach", tile), "Could not remove")}>
            Remove
          </button>
        </div>
      </div>
    </li>
  );
}

/** Pick assets already in the project, by name or path. */
function AssetChooser({ exclude, onChoose, onCancel }: {
  exclude: Set<number>;
  onChoose: (ids: number[], names: string[]) => void;
  onCancel: () => void;
}): JSX.Element {
  const [needle, setNeedle] = useState("");
  const [picked, setPicked] = useState<Map<number, string>>(new Map());
  const like = `%${needle.trim()}%`;
  const rows = useQuery(
    "SELECT id, name, identifier FROM asset WHERE " +
    "(name LIKE ? OR identifier LIKE ?) AND " +
    "(lifecycle_status IS NULL OR lifecycle_status <> 'cut') " +
    "ORDER BY name LIMIT 60", [like, like]);
  return (
    <div className="board-dialog board-chooser" role="dialog"
         aria-label="Files already in the project">
      <input type="search" autoFocus placeholder="Find by name or path"
             aria-label="Find a file" value={needle}
             onChange={(e) => setNeedle(e.target.value)} />
      <ul>
        {rows.filter((r) => !exclude.has(Number(r["id"]))).map((r) => {
          const id = Number(r["id"]);
          const name = String(r["name"] ?? r["identifier"]);
          return (
            <li key={id}>
              <label>
                <input type="checkbox" checked={picked.has(id)}
                       onChange={(e) => {
                         const next = new Map(picked);
                         if (e.target.checked) next.set(id, name);
                         else next.delete(id);
                         setPicked(next);
                       }} />
                <span>{name}</span>
                <span className="muted mono">{String(r["identifier"] ?? "")}</span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="ws-create-actions">
        <button className="primary" disabled={picked.size === 0}
                onClick={() => onChoose([...picked.keys()], [...picked.values()])}>
          Add {picked.size === 0 ? "" : picked.size}
        </button>
        <button className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
