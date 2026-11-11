// SPDX-License-Identifier: Apache-2.0
/**
 * ScriptView — Part 3's editing surface.
 *
 * The CM6 view mounts over lineState; this component owns the lifecycle:
 * load rows → blocks → editor; debounced commit (idle/blur/Cmd-S) via
 * commitPlan — a pure projection, no parsing; stale-scene notices with
 * an OFFERED sync (heading edits never mutate scenes on keystroke);
 * Fountain export with derived spacing; and the import flow entry.
 */

import { call } from "../state/api.ts";
import { useEffect, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";

import { EditorState, Transaction } from "@codemirror/state";
import { exec, registry, useStore } from "../state/store.ts";
import {
  readScreenplay, type TitlePageRow,
} from "@scf-core/screenplay/rowModel.ts";
import { lineState, loadLines, mintLineId } from "../editor/lineState.ts";
import { planSceneMove, sceneBlocks } from "@scf-core/screenplay/sceneMove.ts";

import { reanchorSpansForMove } from "@scf-core/ops/structureCommit.ts";
import {
  blocksToDoc, rowsToBlocks, sceneSyncFromHeading, type Block, type LineEvent,
} from "@scf-core/screenplay/blocks.ts";
import { commitPlan } from "../editor/screenplayDoc.ts";
import {
  screenplayExtensions, setAnnotations, type LineAnnotation,
} from "../editor/extensions.ts";
import { lineEntries, lineEvents } from "../editor/lineState.ts";
import {
  planCommitLinks, validateTags,
  type CommitPlanInfo,
} from "@scf-core/ops/features.ts";
import { paginationFor } from "../editor/extensions.ts";
import { ImportFlow } from "./ImportFlow.tsx";
import { IntegrityPanel } from "./IntegrityPanel.tsx";
import { useQuery } from "./useQuery.ts";
import { scanIntegrity } from "@scf-core/ops/integrity.ts";


/**
 * Every async path here must check this before touching the database.
 * The editor's debounced commit, blur commit and annotation refresh all
 * outlive the view by a tick, so closing a project or opening another
 * one landed them on a closed connection ("no database open"). A closed
 * project has nothing to save that was not already saved.
 */
const projectOpen = (): boolean => useStore.getState().phase === "open";

/** Cross-component handle for the scene rail's jump-to-line. */
export const scriptViewHandle: {
  scrollToLineOrder: ((order: number) => void) | null;
  /** Jump to a line by its uuid. Prefer this: the document drops stored
   *  blank rows and lays out its own spacing, so a table's line_order is
   *  not a document line number. */
  scrollToLineId: ((id: string) => boolean) | null;
  /** Move a scene block so it sits before `beforeSceneId` (null = last).
   * The Scene Rail's drag calls this; the scene ENTITY is never touched,
   * so its beats, shots and links follow by construction. */
  moveScene: ((sceneId: number,
               beforeSceneId: number | null) => void) | null;
  /** Line uuids of a scene's block, for counting what a removal takes. */
  sceneLineIds: ((sceneId: number) => string[]) | null;
  /** Hard remove: the scene, its block, and everything it owns. */
  removeScene: ((sceneId: number) => Promise<void>) | null;
  /** Newly minted copy of the scene and its block, inserted after it. */
  duplicateScene: ((sceneId: number) => Promise<void>) | null;
} = {
  scrollToLineOrder: null, scrollToLineId: null, moveScene: null,
  sceneLineIds: null,
  removeScene: null, duplicateScene: null,
};

/** Editing position survives leaving the Script tab (opening an entity
 * from a chip unmounts the editor; coming back should not mean "top of
 * the screenplay"). */
let savedPosition: { head: number; scrollTop: number } | null = null;

interface StaleNotice {
  uuid: string;
  sceneId: number;
  headingText: string;
  /** What the scene entity currently stores, so the notice can show the
   * actual disagreement rather than describing one. */
  sceneName: string;
  /** The scene's label, as written (spec §4.2). */
  sceneNumber: string | null;
}

function smartTitleLocal(x: string): string {
  return x.toLowerCase().replace(/(^|[\s\-'/(])\p{L}/gu,
                                 (c) => c.toUpperCase());
}

export function ScriptView(): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const prevBlocksRef = useRef<Map<string, Block>>(new Map());
  const titlePageRef = useRef<TitlePageRow[]>([]);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [importing, setImporting] = useState(false);
  const [stale, setStale] = useState<StaleNotice[]>([]);
  const [selection, setSelection] =
    useState<{ lineId: string; from: number; to: number;
               text: string } | null>(null);
  const [showIntegrity, setShowIntegrity] = useState(false);
  const [integrityCount, setIntegrityCount] = useState(0);
  const [liveLineIds, setLiveLineIds] =
    useState<ReadonlySet<string>>(() => new Set());
  const pendingEvents = useRef<LineEvent[]>([]);
  const entityNamesRef = useRef<{ locations: string[];
                                  characters: string[] }>(
    { locations: [], characters: [] });
  const [commitNote, setCommitNote] = useState("");
  const [review, setReview] = useState<CommitPlanInfo | null>(null);
  // "keep" is the default and does nothing: a flagged cue is a QUESTION,
  // and both other answers are destructive, so neither may be what the
  // dialog does when the author just presses the confirm button.
  const [resolutions, setResolutions] =
    useState<Map<string, "keep" | "create" | "rename">>(new Map());
  const [pageInfo, setPageInfo] = useState({ page: 1, total: 1 });
  const [zoom, setZoom] = useState(() => {
    const v = Number(localStorage.getItem("scf:editor-zoom"));
    return Number.isFinite(v) && v >= 0.7 && v <= 2 ? v : 1;
  });
  const [pageMode, setPageMode] = useState<"light" | "dark">(() =>
    localStorage.getItem("scf:editor-mode") === "dark" ? "dark" : "light");
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const say = (message: string): void => {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  };
  const [showAnnot, setShowAnnot] = useState(() =>
    localStorage.getItem("scf:editor-annot") !== "hidden");
  const [dirty, setDirty] = useState(false);
  const [menu, setMenu] =
    useState<{ x: number; y: number } | null>(null);

  const setZoomClamped = (z: number): void => {
    const clamped = Math.min(2, Math.max(0.7, Math.round(z * 10) / 10));
    setZoom(clamped);
    localStorage.setItem("scf:editor-zoom", String(clamped));
  };
  const togglePageMode = (): void => {
    const next = pageMode === "light" ? "dark" : "light";
    setPageMode(next);
    localStorage.setItem("scf:editor-mode", next);
  };
  const toggleAnnot = (): void => {
    const next = !showAnnot;
    setShowAnnot(next);
    localStorage.setItem("scf:editor-annot",
                         next ? "shown" : "hidden");
  };
  const { openEntityRow } = useStore();

  const refreshAnnotations = async (): Promise<void> => {
    const view = viewRef.current;
    if (view === null || !projectOpen()) return;
    const map = new Map<string, LineAnnotation>();
    const entries = lineEntries(view.state);
    const textById = new Map<string, string>();
    entries.forEach((e, i) => {
      textById.set(e.id, view.state.doc.line(i + 1).text);
    });
    // Entity chips from the committed blocks' links.
    const sceneIds = new Set<number>();
    const charIds = new Set<number>();
    for (const b of prevBlocksRef.current.values()) {
      if (b.type === "heading" && b.sceneId !== null) {
        sceneIds.add(b.sceneId);
      }
      if (b.type === "character" && b.characterId !== null) {
        charIds.add(b.characterId);
      }
    }
    const nameOf = async (table: string, ids: Set<number>):
        Promise<Map<number, string>> => {
      if (ids.size === 0) return new Map();
      const rows = await exec(
        `SELECT id, name FROM ${table} WHERE id IN ` +
        `(${[...ids].map(() => "?").join(",")})`, [...ids]);
      return new Map(rows.map((r) =>
        [r["id"] as number, String(r["name"])]));
    };
    const sceneNames = await nameOf("scene", sceneIds);
    const charNames = await nameOf("character", charIds);
    for (const b of prevBlocksRef.current.values()) {
      if (b.type === "heading" && b.sceneId !== null) {
        const label = sceneNames.get(b.sceneId);
        if (label !== undefined) {
          map.set(b.id, { chip: { label: "⛭ scene", entity: "scene",
                                  entityId: b.sceneId } });
        }
      } else if (b.type === "character" && b.characterId !== null) {
        const label = charNames.get(b.characterId);
        if (label !== undefined) {
          map.set(b.id, { chip: { label, entity: "character",
                                  entityId: b.characterId } });
        }
      }
    }
    // Beat dots.
    const beatRows = await exec(
      "SELECT line_ref, COUNT(*) AS n FROM performance_beat " +
      "WHERE line_ref IS NOT NULL GROUP BY line_ref");
    for (const r of beatRows) {
      const id = String(r["line_ref"]);
      map.set(id, { ...(map.get(id) ?? {}), beats: r["n"] as number });
    }
    // Prop-tag ranges with honest validation.
    const locationNames = await exec("SELECT name FROM location");
    const characterNames = await exec("SELECT name FROM character");
    entityNamesRef.current = {
      locations: locationNames.map((r) => String(r["name"])),
      characters: characterNames.map((r) => String(r["name"])),
    };
    const tags = await validateTags(exec, textById);
    for (const t of tags) {
      if (t.status === "detached") continue;
      const ann = map.get(t.lineId) ?? {};
      map.set(t.lineId, {
        ...ann,
        tags: [...(ann.tags ?? []),
               { from: t.startOffset, to: t.endOffset,
                 status: t.status, propName: t.propName }],
      });
    }
    // The integrity scan needs the ids the DOCUMENT holds, not the ones
    // that last reached disk — the author is looking at the document.
    const live = new Set(entries.map((e) => e.id));
    setLiveLineIds(live);
    setIntegrityCount((await scanIntegrity(exec, live, registry)).total);
    view.dispatch({ effects: setAnnotations.of(map) });
  };

  const commitQueue = useRef<Promise<void>>(Promise.resolve());

  /**
   * Every commit runs alone.
   *
   * The old scheme coalesced the DEBOUNCED commit against itself, but
   * `explicitCommit` bypassed it — it called `commit()`, which returned
   * immediately when one was already in flight, and then carried on
   * writing. Two `writeScreenplay` passes and two `withTransaction`
   * blocks overlapped, which is where "cannot rollback — no transaction
   * is active" came from, and why a Commit press could be swallowed: one
   * pass created the scene and the other overwrote the rows that pointed
   * at it, leaving the record behind with nothing linked to it. That is
   * the ghost scene.
   *
   * A queue instead of a flag. Redundant passes are cheap; overlapping
   * ones corrupt.
   */
  const serialize = <T,>(work: () => Promise<T>): Promise<T> => {
    const run = commitQueue.current.then(work, work);
    commitQueue.current = run.then(() => undefined, () => undefined);
    return run;
  };

  /**
   * `reportStale` gates the heading/scene disagreement notice. The
   * debounced auto-save must NOT raise it: it fires 1.2s after the first
   * keystroke into a heading, so the author was told the script and the
   * scene disagreed before they had finished typing the new slug. Blur
   * and an explicit Commit mean the thought is finished.
   */
  const commit = async (reportStale = false): Promise<void> => {
    if (!projectOpen()) return;
    return serialize(() => commitInner(reportStale));
  };

  const commitInner = async (reportStale: boolean): Promise<void> => {
    const view = viewRef.current;
    if (view === null || !projectOpen()) return;
    const plan = commitPlan(view.state, prevBlocksRef.current);
    const created = await call("script.commit", {
      rows: plan.rows, titlePage: titlePageRef.current,
      link: { createNew: false },
    });
    const parts: string[] = [];
    if (created.scenesCreated > 0) {
      parts.push(`${String(created.scenesCreated)} scene(s)`);
    }
    if (created.locationsCreated > 0) {
      parts.push(`${String(created.locationsCreated)} location(s)`);
    }
    if (created.charactersCreated > 0) {
      parts.push(`${String(created.charactersCreated)} character(s)`);
    }
    if (created.actsCreated > 0) {
      parts.push(`${String(created.actsCreated)} act(s)`);
    }
    if (created.sequencesCreated > 0) {
      parts.push(`${String(created.sequencesCreated)} sequence(s)`);
    }
    setCommitNote(parts.length > 0
      ? `created ${parts.join(", ")}` : "");
    prevBlocksRef.current = new Map(plan.rows.map((r) => [r.uuid!, {
      id: r.uuid!, type: r.lineType as Block["type"], text: r.content,
      sceneId: r.sceneId, characterId: r.characterId,
      locationId: r.locationId, metadata: r.metadata,
    }]));
    const events = pendingEvents.current;
    pendingEvents.current = [];
    if (events.length > 0) {
      await call("script.reanchor", events);
    }
    // Derived rather than trusted to the moment of tagging: a prop
    // tagged on a line that had not been committed yet could not know
    // its scene at the time.
    await call("script.syncPropScenes");
    if (reportStale && plan.staleScenes.length > 0) {
      const ids = plan.staleScenes
        .map((s) => s.sceneId)
        .filter((id): id is number => id !== null);
      const named = ids.length === 0 ? [] : await exec(
        `SELECT id, name, scene_number FROM scene WHERE id IN ` +
        `(${ids.map(() => "?").join(",")})`, ids);
      const nameById = new Map(named.map((r) =>
        [r["id"] as number, r]));
      setStale((old) => {
        const merged = new Map(old.map((s) => [s.uuid, s]));
        for (const s of plan.staleScenes) {
          if (s.sceneId === null) continue;
          const row = nameById.get(s.sceneId);
          merged.set(s.uuid, {
            uuid: s.uuid, sceneId: s.sceneId,
            headingText: s.headingText,
            sceneName: String(row?.["name"] ?? ""),
            // A label, not a number, since schema 2.9 — the old
            // `typeof === "number"` guard silently made every scene
            // read as unnumbered.
            sceneNumber: row?.["scene_number"] === null ||
              row?.["scene_number"] === undefined ||
              String(row["scene_number"]).trim() === ""
              ? null : String(row["scene_number"]).trim(),
          });
        }
        return [...merged.values()];
      });
    }
    await refreshAnnotations();
    // The Commit light was only ever recomputed at mount and after an
    // EXPLICIT commit, so typing a new character cue left it dark until
    // something unrelated refreshed it. The auto-save is the moment the
    // answer can have changed.
    await updateDirty();
  };

  /** The Commit button / Cmd-S: preview creations and conflicts, and
   * only create after the author has reviewed them. */
  const explicitCommit = async (): Promise<void> => {
    const view = viewRef.current;
    if (view === null || !projectOpen()) return;
    return serialize(() => explicitCommitInner(view));
  };

  const explicitCommitInner = async (view: EditorView): Promise<void> => {
    // commitInner, not commit(): we already hold the queue.
    await commitInner(true); // text + existing links are always safe
    const plan = commitPlan(view.state, prevBlocksRef.current);
    const info = await planCommitLinks(exec, plan.rows);
    console.debug("[commit-plan]",
      { newLocations: info.newLocations.map((l) => l.name),
        newCharacters: info.newCharacters.map((c) => c.cue),
        conflicts: info.conflicts.length,
        headings: plan.rows
          .filter((r) => r.lineType === "heading")
          .map((r) => ({ content: r.content, sceneId: r.sceneId })) });
    if (info.newLocations.length === 0 &&
        info.newCharacters.length === 0 && info.conflicts.length === 0 &&
        info.newActs.length === 0 && info.newSequences.length === 0) {
      if (info.newScenes > 0) {
        const created = await call("script.commit", {
          rows: plan.rows, titlePage: titlePageRef.current,
          link: { createNew: true },
        });
        prevBlocksRef.current = new Map(plan.rows.map((r) => [r.uuid!, {
          id: r.uuid!, type: r.lineType as Block["type"],
          text: r.content, sceneId: r.sceneId,
          characterId: r.characterId, locationId: r.locationId,
          metadata: r.metadata,
        }]));
        setCommitNote(created.scenesCreated > 0
          ? `created ${String(created.scenesCreated)} scene(s)` : "");
        await refreshAnnotations();
      }
      setDirty(false);
      return;
    }
    setResolutions(new Map());
    setReview(info);
  };

  /** Applying the review writes too, so it queues like everything else. */
  const confirmReview = async (): Promise<void> =>
    serialize(() => confirmReviewInner());

  const confirmReviewInner = async (): Promise<void> => {
    const view = viewRef.current;
    if (view === null || review === null) return;
    const plan = commitPlan(view.state, prevBlocksRef.current);
    const unlinkUuids = new Set<string>();
    const renames = new Map<number, string>();
    for (const c of review.conflicts) {
      const choice = resolutions.get(c.uuid) ?? "keep";
      if (choice === "create") unlinkUuids.add(c.uuid);
      else if (choice === "rename") {
        renames.set(c.entityId, smartTitleLocal(c.cue));
      }
    }
    const created = await call("script.commit", {
      rows: plan.rows, titlePage: titlePageRef.current,
      link: { createNew: true, unlinkUuids: [...unlinkUuids],
              renames: [...renames] },
    });
    prevBlocksRef.current = new Map(plan.rows.map((r) => [r.uuid!, {
      id: r.uuid!, type: r.lineType as Block["type"], text: r.content,
      sceneId: r.sceneId, characterId: r.characterId,
      locationId: r.locationId, metadata: r.metadata,
    }]));
    // Renames may have rewritten cue lines — reflect them in the doc.
    const current = commitPlan(view.state, prevBlocksRef.current);
    for (const r of plan.rows) {
      const live = current.rows.find((x) => x.uuid === r.uuid);
      if (live !== undefined && live.content !== r.content) {
        const lineIdx = plan.rows.indexOf(r);
        const line = view.state.doc.line(
          Math.min(lineIdx + 1, view.state.doc.lines));
        view.dispatch({ changes: { from: line.from, to: line.to,
                                   insert: r.content } });
      }
    }
    const parts: string[] = [];
    if (created.scenesCreated > 0) {
      parts.push(`${String(created.scenesCreated)} scene(s)`);
    }
    if (created.locationsCreated > 0) {
      parts.push(`${String(created.locationsCreated)} location(s)`);
    }
    if (created.charactersCreated > 0) {
      parts.push(`${String(created.charactersCreated)} character(s)`);
    }
    if (created.actsCreated > 0) {
      parts.push(`${String(created.actsCreated)} act(s)`);
    }
    if (created.sequencesCreated > 0) {
      parts.push(`${String(created.sequencesCreated)} sequence(s)`);
    }
    setCommitNote(parts.length > 0
      ? `created ${parts.join(", ")}` : "");
    setReview(null);
    setDirty(false);
    await refreshAnnotations();
    await updateDirty();
  };

  /** The Commit light means "entity work is pending": new scenes,
   * locations, characters, or cue/entity conflicts. Text itself is
   * auto-saved continuously and never needs the button. */
  const updateDirty = async (): Promise<void> => {
    const view = viewRef.current;
    if (view === null || !projectOpen()) return;
    const plan = commitPlan(view.state, prevBlocksRef.current);
    const info = await planCommitLinks(exec, plan.rows);
    setDirty(info.newScenes > 0 || info.newLocations.length > 0 ||
             info.newCharacters.length > 0 || info.conflicts.length > 0 ||
             info.newActs.length > 0 || info.newSequences.length > 0);
  };

  const scheduleCommit = (): void => {
    if (commitTimer.current !== null) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      void commit();
    }, 1200);
  };

  const loadIntoEditor = (blocks: Block[]): void => {
    const view = viewRef.current;
    if (view === null) return;
    const { doc, entries } = blocksToDoc(blocks);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc },
      effects: loadLines.of(entries),
      // Loading a document is not an edit. Without this the import
      // itself sat on the undo stack, so one Ctrl-Z after importing
      // reverted the whole script to the empty document it replaced —
      // and redo brought it back as undifferentiated action lines,
      // because the line identities went with it.
      annotations: Transaction.addToHistory.of(false),
    });
    prevBlocksRef.current = new Map(blocks.map((b) => [b.id, b]));
    setEmpty(blocks.length === 0);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    // Set when this mount is torn down. React's StrictMode mounts the
    // view twice in development; the first mount's load keeps running
    // after teardown, and must not consume a one-shot request (an "open
    // the script at this line" from another section) that the second,
    // real mount is waiting for.
    let disposed = false;
    const view = new EditorView({
      state: EditorState.create({
        doc: "",
        extensions: [
          screenplayExtensions({
            onCommitRequest: () => void explicitCommit(),
            // A character, location or prop chip opens that workspace,
            // where everything about it is; other chips open the record.
            onChipClick: (entity, entityId) =>
              entity === "character" || entity === "location" ||
              entity === "prop"
                ? useStore.getState().openSubject(entity, entityId)
                : void openEntityRow(entity, entityId),
            getLocations: () => entityNamesRef.current.locations,
            getCharacters: () => entityNamesRef.current.characters,
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              pendingEvents.current.push(...lineEvents(u.state));
            }
            // A Tab retype changes no TEXT — it changes a line's type,
            // which lives in state. So nothing was scheduled, nothing
            // committed, and updateDirty never ran: retyping a run of
            // action lines into character and dialogue created the
            // characters at the next commit while the Commit light sat
            // dark. Comparing the field catches every change to the
            // entry array, whichever effect caused it.
            if (u.docChanged ||
                u.startState.field(lineState) !== u.state.field(lineState)) {
              scheduleCommit();
            }
            if (u.viewportChanged || u.docChanged || u.selectionSet) {
              // "The page you are viewing": the line at the top of the
              // visible viewport, through the manuscript-row model.
              const pagination = paginationFor(u.state);
              const topLine =
                u.state.doc.lineAt(u.view.viewport.from).number;
              setPageInfo({
                page: pagination.pageOfLine(topLine),
                total: pagination.total,
              });
              // Stabilize the scrollbar with the MEASURED height (the
              // row-model estimate overshot and left blank pages at the
              // end). Never shrinks mid-scroll, so the thumb maps 1:1.
              if (u.docChanged) {
                u.view.contentDOM.style.minHeight = "";
              }
              u.view.requestMeasure({
                read: (v) => v.contentHeight,
                write: (h, v) => {
                  v.contentDOM.style.minHeight = `${String(h)}px`;
                },
              });
            }
            if (u.selectionSet || u.docChanged) {
              const head = u.state.selection.main.head;
              const line = u.state.doc.lineAt(head);
              const entry = lineEntries(u.state)[line.number - 1];
              const sel = u.state.selection.main;
              if (!sel.empty && entry !== undefined &&
                  sel.from >= line.from && sel.to <= line.to) {
                setSelection({
                  lineId: entry.id,
                  from: sel.from - line.from,
                  to: sel.to - line.from,
                  text: u.state.doc.sliceString(sel.from, sel.to),
                });
              } else {
                setSelection(null);
              }
            }
          }),
          EditorView.domEventHandlers({
            blur: () => { void commit(true); },
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    /**
     * Reorder a scene from the Scene Rail's drag.
     *
     * The scene ENTITY is untouched — same id, same uuid, same beats,
     * shots and junction rows. Only the line order changes, so nothing
     * is orphaned and nothing is recreated. Scene numbers follow the new
     * order once numbering lands (Round B).
     */
    scriptViewHandle.moveScene = (sceneId, beforeSceneId) => {
      const entries = lineEntries(view.state);
      const headingIndexes: number[] = [];
      entries.forEach((entry, i) => {
        if (entry.type === "heading") headingIndexes.push(i);
      });
      const blockOfScene = (target: number): number =>
        headingIndexes.findIndex((lineIdx) => {
          const entry = entries[lineIdx];
          return entry !== undefined &&
            prevBlocksRef.current.get(entry.id)?.sceneId === target;
        });

      const from = blockOfScene(sceneId);
      if (from === -1) return;
      const before = beforeSceneId === null
        ? headingIndexes.length : blockOfScene(beforeSceneId);
      if (before === -1) return;

      const lines: string[] = [];
      for (let n = 1; n <= view.state.doc.lines; n++) {
        lines.push(view.state.doc.line(n).text);
      }
      const plan = planSceneMove(lines, entries, from, before);
      if (plan === null) return;

      // The scene order BEFORE the move, so a span anchored to the
      // scene that is leaving can re-anchor to whatever now sits where
      // it did. Captured here because after the dispatch it is gone.
      const orderBefore = headingIndexes
        .map((lineIdx) => {
          const entry = entries[lineIdx];
          return entry === undefined
            ? null : prevBlocksRef.current.get(entry.id)?.sceneId ?? null;
        })
        .filter((id): id is number => id !== null);

      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: plan.doc },
        effects: loadLines.of(plan.entries),
      });
      const landed = view.state.doc.line(
        Math.min(plan.headingAt + 1, view.state.doc.lines));
      view.dispatch({
        selection: { anchor: landed.from },
        effects: EditorView.scrollIntoView(landed.from, { y: "center" }),
      });
      void (async () => {
        const rehomed = await reanchorSpansForMove(
          exec, sceneId, orderBefore);
        // Immediate, not debounced: a move changes scene numbers and
        // every label built from them, and leaving the script and the
        // records disagreeing for a second is how the rail and the
        // Structure tab end up showing different films.
        await commit(true);
        say(rehomed > 0
          ? "scene moved — act/sequence boundary stayed put"
          : "scene moved");
      })();
    };
    /** Blocks are heading-to-heading, the same span used everywhere. */
    const blockRange = (sceneId: number): [number, number] | null => {
      const entries = lineEntries(view.state);
      const blocks = sceneBlocks(entries);
      const index = blocks.findIndex((b) => {
        const entry = entries[b.start];
        return entry !== undefined &&
          prevBlocksRef.current.get(entry.id)?.sceneId === sceneId;
      });
      const block = blocks[index];
      return block === undefined ? null : [block.start, block.end];
    };

    scriptViewHandle.sceneLineIds = (sceneId: number) => {
      const range = blockRange(sceneId);
      if (range === null) return [];
      return lineEntries(view.state)
        .slice(range[0], range[1] + 1).map((e) => e.id);
    };

    /**
     * Hard remove. Not undoable, and the confirmation carries the counts
     * so that is a fair trade rather than a trap.
     */
    scriptViewHandle.removeScene = async (sceneId: number) => {
      const range = blockRange(sceneId);
      const lineIds = scriptViewHandle.sceneLineIds?.(sceneId) ?? [];
      // Re-anchor first: an act anchored to this scene would otherwise
      // vanish from the derived structure and take its scenes with it.
      const entries = lineEntries(view.state);
      const order: number[] = [];
      for (const block of sceneBlocks(entries)) {
        const entry = entries[block.start];
        const id = entry === undefined
          ? undefined : prevBlocksRef.current.get(entry.id)?.sceneId;
        if (id !== undefined && id !== null) order.push(id);
      }
      await reanchorSpansForMove(exec, sceneId, order);
      await call("scene.removeCascade", sceneId, lineIds);

      if (range !== null) {
        const [start, end] = range;
        const lines: string[] = [];
        for (let n = 1; n <= view.state.doc.lines; n++) {
          lines.push(view.state.doc.line(n).text);
        }
        const kept = [...lines.slice(0, start), ...lines.slice(end + 1)];
        const keptEntries = [...entries.slice(0, start),
                             ...entries.slice(end + 1)];
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length,
                     insert: kept.join("\n") },
          effects: loadLines.of(keptEntries),
        });
      }
      // The removal is deliberate and complete, so nothing should be
      // left for undo to half-restore.
      useStore.setState({ undo: null });
      say("scene removed");
      await commit(true);
    };

    /** Newly minted: new record, new lines, new uuids. */
    scriptViewHandle.duplicateScene = async (sceneId: number) => {
      const range = blockRange(sceneId);
      if (range === null) return;
      const [start, end] = range;
      const newId = await call("scene.duplicateRow", sceneId);

      const entries = lineEntries(view.state);
      const lines: string[] = [];
      for (let n = 1; n <= view.state.doc.lines; n++) {
        lines.push(view.state.doc.line(n).text);
      }
      const copiedText = lines.slice(start, end + 1);
      // Fresh identity throughout — a duplicate is new text, so prop
      // tags and beats anchored to the original stay with the original.
      const copiedEntries = entries.slice(start, end + 1)
        .map((e) => ({ id: mintLineId(), type: e.type }));

      const nextLines = [...lines.slice(0, end + 1), ...copiedText,
                         ...lines.slice(end + 1)];
      const nextEntries = [...entries.slice(0, end + 1), ...copiedEntries,
                           ...entries.slice(end + 1)];
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length,
                   insert: nextLines.join("\n") },
        effects: loadLines.of(nextEntries),
      });
      // Link the copied heading to the new record before committing, or
      // the commit would propose creating a third scene from it.
      const headingId = copiedEntries[0]?.id;
      if (headingId !== undefined) {
        prevBlocksRef.current.set(headingId, {
          uuid: headingId, lineType: "heading",
          content: copiedText[0] ?? "", sceneId: newId,
          characterId: null, locationId: null,
        } as never);
      }
      say("scene duplicated");
      await commit(true);
    };

    const jumpToId = (id: string, y: "start" | "center"): boolean => {
      const index = lineEntries(view.state).findIndex((e) => e.id === id);
      if (index < 0) return false;
      const line = view.state.doc.line(index + 1);
      view.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y }),
      });
      view.focus();
      return true;
    };
    scriptViewHandle.scrollToLineId = (id: string) => jumpToId(id, "start");

    scriptViewHandle.scrollToLineOrder = (order: number) => {
      const line = view.state.doc.line(
        Math.min(order + 1, view.state.doc.lines));
      view.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: "start" }),
      });
      view.focus();
    };

    void (async () => {
      const sp = await readScreenplay(exec);
      titlePageRef.current = sp.titlePage;
      loadIntoEditor(rowsToBlocks(sp.lines));
      setLoaded(true);
      await refreshAnnotations();
      await updateDirty();
      // Another section asked to open the script at a line (a character's
      // Scenes & Lines tab): that wins over where the writer last was.
      const asked = disposed
        ? null : useStore.getState().takePendingScriptLine();
      if (asked !== null && jumpToId(asked, "center")) {
        // done
      } else if (savedPosition !== null) {
        const head = Math.min(savedPosition.head,
                              view.state.doc.length);
        // scrollIntoView goes through CM's measure cycle — a raw
        // scrollTop write raced measurement and lost (clamped to top).
        view.dispatch({
          selection: { anchor: head },
          effects: EditorView.scrollIntoView(head, { y: "center" }),
        });
      }
    })();

    return () => {
      disposed = true;
      if (commitTimer.current !== null) clearTimeout(commitTimer.current);
      // StrictMode double-mounts: its interleaved cleanup runs on a
      // still-empty view and was clobbering the real saved position
      // with 0/top. An empty doc has no position worth saving.
      if (view.state.doc.length > 0) {
        savedPosition = {
          head: view.state.selection.main.head,
          scrollTop: view.scrollDOM.scrollTop,
        };
      }
      scriptViewHandle.scrollToLineOrder = null;
      scriptViewHandle.scrollToLineId = null;
      scriptViewHandle.moveScene = null;
      scriptViewHandle.sceneLineIds = null;
      scriptViewHandle.removeScene = null;
      scriptViewHandle.duplicateScene = null;
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unlinkScene = async (notice: StaleNotice): Promise<void> => {
    await call("scene.unlinkLine", notice.uuid);
    const block = prevBlocksRef.current.get(notice.uuid);
    if (block !== undefined) block.sceneId = null;
    setStale((old) => old.filter((x) => x.uuid !== notice.uuid));
    await refreshAnnotations();
  };

  /**
   * Rename the scene from the heading as typed.
   *
   * The location moves with it. Without that, INT. KITCHEN -> INT. GARAGE
   * renamed the scene and left it pointing at the Kitchen location — a
   * sync that visibly did not sync. A location that does NOT exist yet is
   * left alone rather than created: Sync is a repair, and entity creation
   * belongs to the Commit review where it can be seen first. The notice
   * says so.
   */
  const syncScene = async (notice: StaleNotice): Promise<void> => {
    const fields = sceneSyncFromHeading(notice.headingText);
    const locationId =
      await call("scene.syncFromHeading", notice.sceneId, fields);
    setStale((old) => old.filter((s) => s.uuid !== notice.uuid));
    say(fields.location !== null && locationId === null
      ? `renamed — "${fields.location}" is not a location yet, so Commit will offer to create it`
      : "scene updated from the heading");
    await updateDirty();
  };

  return (
    <div className="script-view">
      <div className="script-toolbar">
        <span className="script-title">Script</span>
        <span className="page-indicator">
          p. {pageInfo.page}/{pageInfo.total}
        </span>
        <span className="flex-spacer" />
        <span className="zoom-controls">
          <button onClick={() => setZoomClamped(zoom - 0.1)}
                  title="Zoom out" aria-label="zoom out">−</button>
          <span className="zoom-level">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoomClamped(zoom + 0.1)}
                  title="Zoom in" aria-label="zoom in">＋</button>
        </span>
        <button onClick={togglePageMode}
                title={pageMode === "light"
                  ? "Switch page to dark" : "Switch page to light"}>
          {pageMode === "light" ? "☾" : "☀"}
        </button>
        <button onClick={toggleAnnot} aria-pressed={showAnnot}
                title={showAnnot
                  ? "Hide entity links (chips, tag underlines, beat dots)"
                  : "Show entity links"}>
          {showAnnot ? "◉ links" : "◎ links"}
        </button>
        {commitNote !== "" && (
          <span className="commit-note">{commitNote}</span>
        )}
        <TagControl selection={selection} onTagged={(name) => {
          say(`tagged as ${name}`);
          void refreshAnnotations();
        }} />
        {integrityCount > 0 && (
          <button className="integrity-flag"
                  aria-pressed={showIntegrity}
                  title="Prop tags, beats and cast links whose script text is gone. Nothing is removed without your say-so."
                  onClick={() => setShowIntegrity(!showIntegrity)}>
            ⚑ {integrityCount} dangling
          </button>
        )}
        <button className={dirty ? "commit-dirty" : "commit-clean"}
                onClick={() => void explicitCommit()}
                title="Cmd/Ctrl-S — reviews new entities before creating">
          Commit
        </button>
      </div>
      {stale.length > 0 && (
        <div className="stale-bar">
          {stale.map((s) => {
            const label = s.sceneNumber === null
              ? "This scene" : `Scene ${s.sceneNumber}`;
            const emptied = s.headingText.trim() === "";
            return (
              <span key={s.uuid} className="stale-notice">
                {emptied ? (
                  <>
                    You cleared the heading for{" "}
                    <em>{s.sceneName}</em>, but this line is still linked
                    to it.
                  </>
                ) : (
                  <>
                    {label} is stored as <em>{s.sceneName}</em>, but this
                    line now reads <em>{s.headingText}</em>.
                  </>
                )}
                {!emptied && (
                  <button onClick={() => void syncScene(s)}
                          title="Update the scene record — its name, int/ext, time of day and location — to match the line as written. Use this when it is the same scene, renamed.">
                    Rename {s.sceneNumber === null
                      ? "the scene" : `scene ${s.sceneNumber}`}
                  </button>
                )}
                <button onClick={() => void unlinkScene(s)}
                        title="Break this line's link. The scene record stays exactly as it is, unused by the script; the next Commit offers to create a fresh scene from this line.">
                  {emptied
                    ? "Take the scene out of the script"
                    : "Make this a new scene"}
                </button>
                <button onClick={() =>
                  void openEntityRow("scene", s.sceneId)}
                        title="Look at the scene record before deciding.">
                  Open {s.sceneName === "" ? "the scene" : s.sceneName}
                </button>
                <button onClick={() => setStale((old) =>
                  old.filter((x) => x.uuid !== s.uuid))}
                        title="Hide this. Nothing changes — the line and the scene stay as they are.">
                  Leave both
                </button>
              </span>
            );
          })}
        </div>
      )}
      {loaded && empty && !importing && (
        <div className="script-empty">
          <p>No screenplay in this project yet.</p>
          <button className="primary" onClick={() => setImporting(true)}>
            Import Fountain / FDX
          </button>
          <button onClick={() => {
            loadIntoEditor([{
              id: crypto.randomUUID(), type: "heading",
              text: "INT. ", sceneId: null, characterId: null,
              locationId: null, metadata: null,
            }]);
            viewRef.current?.focus();
          }}>
            Start blank
          </button>
        </div>
      )}
      <div className="script-body">
        <div ref={hostRef}
             style={{ fontSize: `${String(13 * zoom)}px` }}
             onContextMenu={(e) => {
               if (selection !== null &&
                   selection.text.trim() !== "") {
                 e.preventDefault();
                 setMenu({ x: e.clientX, y: e.clientY });
               }
             }}
             className={"script-editor" +
               (empty ? " hidden" : "") +
               (pageMode === "dark" ? " page-dark" : "") +
               (showAnnot ? "" : " hide-annot")} />
      {toast !== null && (
        <div className="script-toast" role="status">{toast}</div>
      )}
        {showIntegrity && (
          <IntegrityPanel liveLineIds={liveLineIds}
                          onClose={() => setShowIntegrity(false)}
                          onChanged={() => {
                            void refreshAnnotations();
                          }} />
        )}
      </div>
      {menu !== null && selection !== null && (
        <PropContextMenu
          at={menu}
          selection={selection}
          onClose={() => setMenu(null)}
          onDone={() => {
            setMenu(null);
            void refreshAnnotations();
          }} />
      )}
      {review !== null && (
        <div className="modal-scrim" role="dialog" aria-modal="true">
          <div className="modal commit-review">
            <div className="modal-head">
              <h2>Review before creating</h2>
              <button onClick={() => setReview(null)}
                      aria-label="close">×</button>
            </div>
            {review.newScenes > 0 && (
              <p className="muted">
                {review.newScenes} new scene(s) will be created from
                unlinked headings.
              </p>
            )}
            {review.newLocations.length > 0 && (
              <>
                <h3>New locations</h3>
                <ul className="review-list">
                  {review.newLocations.map((l) => (
                    <li key={l.name}>
                      <b>{l.name}</b>
                      {l.similar.length > 0 && (
                        <span className="muted">
                          {" "}— similar existing:{" "}
                          {l.similar.join(", ")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {(review.newActs.length > 0 ||
              review.newSequences.length > 0) && (
              <>
                <h3>New structure</h3>
                <ul className="review-list">
                  {review.newActs.map((a) => (
                    <li key={`act:${a}`}>
                      <b>{a}</b>
                      <span className="muted"> — act, starting at the
                        next scene below it</span>
                    </li>
                  ))}
                  {review.newSequences.map((x) => (
                    <li key={`seq:${x}`}>
                      <b>{x}</b>
                      <span className="muted"> — sequence, starting at
                        the next scene below it</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {review.danglingSections.length > 0 && (
              <p className="muted">
                No scene follows {review.danglingSections.join(", ")},
                so {review.danglingSections.length === 1
                  ? "it anchors" : "they anchor"} nothing yet.
              </p>
            )}
            {review.newCharacters.length > 0 && (
              <>
                <h3>New characters</h3>
                <ul className="review-list">
                  {review.newCharacters.map((c) => (
                    <li key={c.cue}>
                      <b>{c.cue}</b>
                      {c.similar.length > 0 && (
                        <span className="muted">
                          {" "}— similar existing:{" "}
                          {c.similar.join(", ")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {review.conflicts.length > 0 && (
              <>
                <h3>Cue / entity mismatches</h3>
                <ul className="review-list">
                  {review.conflicts.map((c) => (
                    <li key={c.uuid} className="review-conflict">
                      Line says <b>{c.cue}</b> but is linked to{" "}
                      <b>{c.entityName}</b>.
                      <label>
                        <input type="radio" name={`res-${c.uuid}`}
                               checked={(resolutions.get(c.uuid) ??
                                         "keep") === "keep"}
                               onChange={() => setResolutions((old) =>
                                 new Map(old).set(c.uuid, "keep"))} />
                        leave as is — the link is right
                      </label>
                      <label>
                        <input type="radio" name={`res-${c.uuid}`}
                               checked={resolutions.get(c.uuid) ===
                                        "create"}
                               onChange={() => setResolutions((old) =>
                                 new Map(old).set(c.uuid, "create"))} />
                        break link; create/match “{c.cue}”
                      </label>
                      <label>
                        <input type="radio" name={`res-${c.uuid}`}
                               checked={resolutions.get(c.uuid) ===
                                        "rename"}
                               onChange={() => setResolutions((old) =>
                                 new Map(old).set(c.uuid, "rename"))} />
                        rename entity to “{smartTitleLocal(c.cue)}” (all
                        its cue lines update)
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="modal-actions">
              <span className="muted">
                Nothing is created until you confirm. Cancel to fix
                spelling in the script first.
              </span>
              <span className="flex-spacer" />
              <button onClick={() => setReview(null)}>Cancel</button>
              <button className="primary"
                      onClick={() => void confirmReview()}>
                Create & commit
              </button>
            </div>
          </div>
        </div>
      )}
      {importing && (
        <ImportFlow
          onClose={() => setImporting(false)}
          onDone={async () => {
            setImporting(false);
            const sp = await readScreenplay(exec);
            titlePageRef.current = sp.titlePage;
            loadIntoEditor(rowsToBlocks(sp.lines));
          }}
        />
      )}
    </div>
  );
}


function TagControl({ selection, onTagged }: {
  selection: { lineId: string; from: number; to: number;
               text: string } | null;
  onTagged: (propName: string) => void;
}): JSX.Element {
  const props = useQuery("SELECT id, name FROM prop ORDER BY name");
  const enabled = selection !== null && selection.text.trim() !== "";
  return (
    <select className="tag-control" value=""
            disabled={!enabled}
            title={selection === null
              ? "Select text within one line to tag it as a prop"
              : `Tag “${selection.text}” as a prop`}
            onChange={(e) => {
              const value = e.target.value;
              e.target.value = "";
              if (selection === null) return;
              if (value === "__new__") {
                const name = window.prompt(
                  "New prop name:", selection.text.trim());
                if (name === null || name.trim() === "") return;
                void (async () => {
                  const id = await call("script.createProp", name.trim());
                  await call("script.tagProp", selection.lineId,
                                     id, selection.text,
                                     selection.from, selection.to);
                  onTagged(name.trim());
                })();
                return;
              }
              const propId = Number(value);
              if (!Number.isFinite(propId)) return;
              const propName = String(
                props.find((r) => Number(r["id"]) === propId)?.["name"] ??
                "prop");
              void call("script.tagProp", selection.lineId, propId,
                                selection.text, selection.from,
                                selection.to).then(() => onTagged(propName));
            }}>
      <option value="" disabled>⌁ tag prop</option>
      <option value="__new__">＋ create new prop…</option>
      {props.map((p) => (
        <option key={String(p["id"])} value={String(p["id"])}>
          {String(p["name"])}
        </option>
      ))}
    </select>
  );
}

function PropContextMenu({ at, selection, onClose, onDone }: {
  at: { x: number; y: number };
  selection: { lineId: string; from: number; to: number; text: string };
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const props = useQuery("SELECT id, name FROM prop ORDER BY name");
  const tag = async (propId: number): Promise<void> => {
    await call("script.tagProp", selection.lineId, propId, selection.text,
                       selection.from, selection.to);
    onDone();
  };
  const createAndTag = async (): Promise<void> => {
    const name = window.prompt("New prop name:", selection.text.trim());
    if (name === null || name.trim() === "") {
      onClose();
      return;
    }
    await tag(await call("script.createProp", name.trim()));
  };
  return (
    <>
      <div className="ctx-scrim" onClick={onClose}
           onContextMenu={(e) => {
             e.preventDefault();
             onClose();
           }} />
      <div className="ctx-menu" role="menu"
           style={{
             left: Math.min(at.x, window.innerWidth - 240),
             top: Math.min(at.y, window.innerHeight - 200),
           }}>
        <div className="ctx-head">
          Tag &ldquo;{selection.text.length > 24
            ? `${selection.text.slice(0, 24)}…`
            : selection.text}&rdquo; as prop
        </div>
        <button role="menuitem" onClick={() => void createAndTag()}>
          ＋ New prop…
        </button>
        {props.length > 0 && <div className="ctx-sep" />}
        <div className="ctx-scroll">
          {props.map((p) => (
            <button key={String(p["id"])} role="menuitem"
                    onClick={() => void tag(p["id"] as number)}>
              {String(p["name"])}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
