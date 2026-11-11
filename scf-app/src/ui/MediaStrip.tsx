// SPDX-License-Identifier: Apache-2.0
import { call } from "../state/api.ts";
import { useEffect, useState } from "react";
import { exec, useStore } from "../state/store.ts";
import {
  loadMedia, MEDIA_HELP, MEDIA_LABEL, MEDIA_TYPES, mediaLabel,
  type MediaOwner, type MediaTile,
} from "@scf-core/ops/relatedMediaOps.ts";
import { withCreatedAssets } from "@scf-core/ops/mediaOps.ts";
import type { ChangeUndo } from "@scf-core/ops/undoChange.ts";
import { fail, FileIntake, type Incoming } from "./workspace/BoardParts.tsx";
import { AssetThumb } from "./AssetThumb.tsx";
import { assetStanding } from "@scf-core/assetStanding.ts";
import { StandingTag } from "./StandingTag.tsx";

/**
 * MediaStrip — the files a shot or a scene points at, in order.
 *
 * Storyboard panels, start and end frames, previs, references. Drop or
 * pick files, say what they are for, and the asset_relationship rows are
 * written for you (relatedMediaOps.ts). The order on screen is the order
 * stored, so a storyboard reads left to right as it will to any tool.
 */
export function MediaStrip({ owner }: { owner: MediaOwner }): JSX.Element {
  const { revision, openEntityRow } = useStore();
  const [tiles, setTiles] = useState<MediaTile[] | null>(null);
  const [incoming, setIncoming] = useState<Incoming | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadMedia(exec, owner).then((t) => {
      if (!cancelled) setTiles(t);
    }).catch((e: unknown) => fail("Could not read the media", e));
    return () => { cancelled = true; };
  }, [owner.kind, owner.id, revision]);

  const done = (change: ChangeUndo | null): void => {
    if (change !== null) useStore.getState().recordChange(change);
  };
  const run = (p: Promise<ChangeUndo | null>, what: string): void => {
    p.then(done).catch((e: unknown) => fail(what, e));
  };

  const place = async (type: string): Promise<void> => {
    if (incoming === null) return;
    try {
      const { assetIds, created } = await call(
        "media.registerFiles", incoming.candidates);
      const change = await call(
        "relatedMedia.attach", owner,
        [...incoming.assetIds, ...assetIds], type);
      done(withCreatedAssets(change, created));
      setIncoming(null);
    } catch (e) {
      fail("Could not add the files", e);
    }
  };

  const list = tiles ?? [];
  return (
    <div className="media-strip">
      <FileIntake compact onFiles={setIncoming}
                  exclude={new Set(list.map((t) => Number(t.asset["id"])))} />

      {incoming !== null && (
        <div className="board-dialog" role="dialog"
             aria-label="What are these files for?">
          <p>
            What {incoming.names.length === 1
              ? <>is <strong>{incoming.names[0]}</strong></>
              : <>are these <strong>{incoming.names.length} files</strong></>}
            {" "}for?
          </p>
          <div className="board-purposes">
            {MEDIA_TYPES.map((t) => (
              <button key={t} className="board-purpose"
                      onClick={() => void place(t)}>
                <strong>{MEDIA_LABEL[t]}</strong>
                <span>{MEDIA_HELP[t]}</span>
              </button>
            ))}
          </div>
          <div className="ws-create-actions">
            <button className="ghost" onClick={() => setIncoming(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {tiles !== null && list.length === 0 && incoming === null && (
        <p className="muted media-empty">
          No media on this {owner.kind} yet. Storyboard panels keep the
          order you give them.
        </p>
      )}

      {list.length > 0 && (
        <ol className="media-tiles">
          {list.map((t, i) => (
            <MediaTileView key={t.linkId} tile={t} index={i}
                           count={list.length} run={run}
                           onMove={(d) => run(call("relatedMedia.move", list, t.linkId, d),
                                              "Could not move it")}
                           onOpen={() => void openEntityRow(
                             "asset", Number(t.asset["id"]))} />
          ))}
        </ol>
      )}
    </div>
  );
}

function MediaTileView({ tile, index, count, run, onMove, onOpen }: {
  tile: MediaTile; index: number; count: number;
  run: (p: Promise<ChangeUndo | null>, what: string) => void;
  onMove: (delta: -1 | 1) => void;
  onOpen: () => void;
}): JSX.Element {
  const { openEntityRow } = useStore();
  const [notes, setNotes] = useState(tile.notes ?? "");
  useEffect(() => { setNotes(tile.notes ?? ""); }, [tile.notes]);
  const identifier = tile.asset["identifier"];
  const name = String(tile.asset["name"] ?? identifier ?? "file");
  const known = (MEDIA_TYPES as readonly string[]).includes(tile.type ?? "");
  const id = `media-${String(tile.linkId)}`;
  // Attached, so referenced by definition: the tag only ever has
  // something to say when the file is history.
  const standing = assetStanding(
    tile.asset["lifecycle_status"] as string | null, true,
    tile.successorName);
  const successorId = tile.asset["superseded_by_id"];

  return (
    <li className={"media-tile media-" + (tile.type ?? "untyped") +
                   (standing.historic ? " media-tile-historic" : "")}>
      <div className="media-thumb">
        <AssetThumb identifier={typeof identifier === "string" ? identifier : null}
                    size="md" detail="tile" alt={name} onClick={onOpen} />
        <span className="media-index">{index + 1}</span>
      </div>
      <div className="media-meta">
        <span className="media-name" title={String(identifier ?? "")}>{name}</span>
        {standing.historic && (
          <StandingTag standing={standing}
                       onOpenSuccessor={successorId === null ||
                         successorId === undefined ? undefined
                         : () => void openEntityRow(
                             "asset", Number(successorId))} />
        )}
        <label className="visually-hidden" htmlFor={id}>
          What {name} is for
        </label>
        <select id={id} value={tile.type ?? ""}
                onChange={(e) => run(call("relatedMedia.setType", tile, e.target.value),
                                     "Could not change what it is for")}>
          {!known && <option value={tile.type ?? ""}>{mediaLabel(tile.type)}</option>}
          {MEDIA_TYPES.map((t) => (
            <option key={t} value={t}>{MEDIA_LABEL[t]}</option>
          ))}
        </select>
        <input aria-label={`Note on ${name}`} value={notes}
               placeholder="note — what it shows"
               onChange={(e) => setNotes(e.target.value)}
               onBlur={() => {
                 if (notes.trim() === (tile.notes ?? "")) return;
                 run(call("relatedMedia.setNotes", tile, notes), "Could not save the note");
               }}
               onKeyDown={(e) => {
                 if (e.key === "Enter") (e.target as HTMLInputElement).blur();
               }} />
        <div className="media-actions">
          <button className="ghost tiny" title="Earlier" disabled={index === 0}
                  onClick={() => onMove(-1)}>◀</button>
          <button className="ghost tiny" title="Later"
                  disabled={index === count - 1}
                  onClick={() => onMove(1)}>▶</button>
          <button className="ghost tiny" title="Show in Assets"
                  onClick={onOpen}>⋯</button>
          <button className="ghost tiny" title="Remove from this shot or scene"
                  onClick={() => run(call("relatedMedia.detach", tile), "Could not remove")}>
            ×
          </button>
        </div>
      </div>
    </li>
  );
}
