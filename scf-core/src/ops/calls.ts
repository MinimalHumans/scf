// SPDX-License-Identifier: Apache-2.0
/**
 * ops/calls.ts — the window's write surface, by name.
 *
 * `opTable.ts` is the small, curated set a tool may call: named
 * arguments, checked against a schema, shown to a model as tools. This
 * is the broader one the editor itself needs — every function the
 * window used to run against its own database, now run by the host on
 * its behalf. Arguments are positional and plain data, exactly the
 * function's own, with the connection (and, for some, the registry)
 * supplied by the host. The signatures are the documentation; the
 * types the client sees are derived from this table, so a call that
 * does not match fails to compile rather than at runtime.
 *
 * Being in this table is what lets a function write: a client can name
 * nothing else. Reads do not need it — they are SQL on the read-only
 * connection. A function that takes a callback or a live object does
 * not belong here; give it a plain-data wrapper, as `script.commit` and
 * `undo.change` below.
 *
 * Arguments cross the wire as JSON, so `undefined` arrives as `null` and
 * a trailing one is dropped by the client. Functions with an optional
 * parameter in the middle take an options object instead.
 */

import { withTransaction, type SqlExec } from "../db.ts";
import type { Registry } from "../registry.ts";
import type { Session } from "../session.ts";
import type { ScfContext } from "../resolution.ts";
import {
  applyAssetImport,
} from "../assetImport.ts";
import { applyRelink } from "../assets.ts";
import {
  applyBundleAdd, bindBundle, bindBundleToCharacter, createBundle,
  removeBundleMember, setMemberRole,
} from "../bundling.ts";
import { setNumberingPolicy } from "../numbering.ts";
import {
  writeScreenplay, type ScreenplayRow, type TitlePageRow,
} from "../screenplay/rowModel.ts";
import * as element from "./elementOps.ts";
import * as features from "./features.ts";
import {
  applyImport, prepareImport, type ImportResult,
} from "./importPipeline.ts";
import * as integrity from "./integrity.ts";
import { unifySpelling } from "./mediaChecks.ts";
import * as media from "./mediaOps.ts";
import * as related from "./relatedMediaOps.ts";
import * as record from "./recordOps.ts";
import * as scene from "./sceneOps.ts";
import * as shoot from "./shootOps.ts";
import * as structure from "./structureCommit.ts";
import { setTitleKey } from "./titlePageOps.ts";
import { applyUndoChange, type ChangeUndo } from "./undoChange.ts";
import { restoreFromUndo } from "./undoDelete.ts";

/** One callable: how to run a function from its positional arguments. */
export interface Callable<A extends unknown[], R> {
  readonly run: (ctx: ScfContext, args: A) => Promise<R>;
}

/** A function of the connection. */
const withExec = <A extends unknown[], R>(
    fn: (exec: SqlExec, ...a: A) => Promise<R>): Callable<A, R> =>
  ({ run: (ctx, args) => fn(ctx.exec, ...args) });

/** A function of the connection and the registry. */
const withCtx = <A extends unknown[], R>(
    fn: (exec: SqlExec, registry: Registry, ...a: A) => Promise<R>):
    Callable<A, R> =>
  ({ run: (ctx, args) => fn(ctx.exec, ctx.registry, ...args) });

// ── plain-data wrappers ────────────────────────────────────────────

export interface ScriptCommit {
  rows: ScreenplayRow[];
  titlePage: TitlePageRow[];
  link: {
    createNew: boolean;
    /** Line uuids to unlink before matching. */
    unlinkUuids?: string[];
    /** Character id → new display name. */
    renames?: [number, string][];
  };
}

/**
 * Link the script's lines to their records and store the lines, as one
 * transaction. The editor used to open that transaction itself around
 * two calls; a transaction cannot span a round trip to the host, so the
 * pair is one operation here.
 */
/** One committed line's links, as the commit left them. */
export interface CommittedLine {
  uuid: string;
  /** The text as stored: a rename in the review rewrites cue lines. */
  content: string;
  sceneId: number | null;
  characterId: number | null;
  locationId: number | null;
  metadata: Record<string, unknown> | null;
}

export interface ScriptCommitResult extends features.CommitLinkResult {
  /**
   * Every line's links after linking, in document order.
   *
   * Linking writes scene, character and location ids (and section
   * bindings) onto the rows it is given. In-process that mutated the
   * caller's own array, which is what the editor relied on; across the
   * host the rows are a copy, so the ids never came back and every
   * later commit took the same headings for unlinked ones and created
   * their scenes again. The caller takes its baseline from this.
   */
  lines: CommittedLine[];
}

async function commitScript(
    exec: SqlExec, p: ScriptCommit): Promise<ScriptCommitResult> {
  return withTransaction(exec, async () => {
    const link = await features.linkAndCreateAtCommit(exec, p.rows, {
      createNew: p.link.createNew,
      ...(p.link.unlinkUuids === undefined
        ? {} : { unlinkUuids: new Set(p.link.unlinkUuids) }),
      ...(p.link.renames === undefined
        ? {} : { renames: new Map(p.link.renames) }),
    });
    await writeScreenplay(exec, {
      bom: false, titlePage: p.titlePage, lines: p.rows,
    });
    return {
      ...link,
      lines: p.rows.map((r) => ({
        uuid: r.uuid ?? "",
        content: r.content,
        sceneId: r.sceneId,
        characterId: r.characterId,
        locationId: r.locationId,
        metadata: r.metadata,
      })),
    };
  });
}

export interface ScriptImport {
  /** The file as text; the host parses it again, so the staging
   *  screen's proposals and the import cannot disagree. */
  raw: string;
  kind: "fountain" | "fdx";
  accepted: {
    scenes: boolean;
    /** Cue key → final display name. */
    characterNames: [string, string][];
    /** Prop key → final display name. */
    props: [string, string][];
  };
}

async function importScreenplay(
    exec: SqlExec, p: ScriptImport): Promise<ImportResult> {
  return applyImport(exec, prepareImport(p.raw, p.kind), {
    scenes: p.accepted.scenes,
    characterNames: new Map(p.accepted.characterNames),
    props: new Map(p.accepted.props),
  });
}

function undoChange(exec: SqlExec, change: ChangeUndo): Promise<void> {
  return withTransaction(exec, () => applyUndoChange(exec, change));
}

// ── the table ──────────────────────────────────────────────────────

export const CALLS = {
  // records
  "record.create": withCtx(record.createRecord),
  "record.update": withCtx(record.updateRecord),
  "record.delete": withCtx(record.deleteRecord),
  "undo.delete": withExec(restoreFromUndo),
  "undo.change": withExec(undoChange),

  // the script
  "script.commit": withExec(commitScript),
  "script.reanchor": withExec(features.reanchorForEvents),
  "script.syncPropScenes": withExec(features.syncPropSceneLinks),
  "script.createBeat": withExec(features.createBeatForLine),
  "script.createProp": withExec(features.createEditorProp),
  "script.tagProp": withExec(features.tagPropRange),
  "script.linkPropToLine": withExec(features.linkPropToLineScene),
  "script.publishVersion": withExec(features.publishVersion),
  "import.apply": withExec(importScreenplay),
  "titlePage.setKey": withExec(setTitleKey),

  // scenes and structure
  "scene.removeCascade": withCtx(scene.removeSceneCascade),
  "scene.duplicateRow": withExec(scene.duplicateSceneRow),
  "scene.unlinkLine": withExec(scene.unlinkLineScene),
  "scene.syncFromHeading": withExec(scene.syncSceneFromHeading),
  "structure.createSpan": withExec(structure.createSpan),
  "structure.setBoundary": withExec(structure.setSpanBoundary),
  "structure.setNumberingMode": withExec(structure.setNumberingMode),
  "structure.renumber": withExec(
    (exec: SqlExec) => structure.renumberSpans(exec)),
  "numbering.setPolicy": withExec(setNumberingPolicy),

  // shoot
  "shoot.addBeat": withExec(shoot.addBeat),
  "shoot.addShot": withExec(shoot.addShot),
  "shoot.updateField": withExec(shoot.updateField),
  "shoot.removeBeat": withExec(shoot.removeBeat),
  "shoot.removeShot": withExec(shoot.removeShot),
  "shoot.setShotCut": withExec(shoot.setShotCut),
  "shoot.moveShot": withExec(shoot.moveShotInScene),

  // characters, locations, props
  "element.createCharacter": withExec(element.createCharacter),
  "element.setField": withCtx(element.setField),
  "element.findOrCreateActor": withExec(element.findOrCreateActor),
  "element.castActor": withExec(element.castActor),
  "element.reassignActor": withExec(element.reassignActor),
  "element.addVariant": withExec(element.addVariant),
  "element.addArc": withExec(element.addArc),
  "element.addStage": withExec(element.addStage),
  "element.relate": withExec(element.relate),
  "element.setDirection": withExec(element.setDirection),
  "element.addCostume": withExec(element.addCostume),
  "element.addHabit": withExec(element.addHabit),
  "element.wearIn": withExec(element.wearIn),
  "element.ensureProgression": withExec(element.ensureProgression),
  "element.addMakeupFor": withExec(element.addMakeupFor),
  "element.addPlaceFor": withExec(element.addPlaceFor),
  "element.linkToScene": withExec(element.linkToScene),
  "element.createSubject": withExec(element.createSubject),
  "element.addVariantOf": withExec(element.addVariantOf),
  "element.linkPropToScene": withExec(element.linkPropToScene),

  // reference media
  "media.attach": withCtx(media.attach),
  "media.moveTile": withExec(media.moveTile),
  "media.detach": withExec(media.detach),
  "media.repurpose": withCtx(media.repurpose),
  "media.confirmIdentity": withExec(media.confirmIdentity),
  "media.setTileRole": withExec(media.setTileRole),
  "media.setAnchorRegion": withExec(media.setAnchorRegion),
  "media.setAnchorClip": withExec(media.setAnchorClip),
  "media.addException": withCtx(media.addException),
  "media.updateException": withCtx(media.updateException),
  "media.moveException": withCtx(media.moveException),
  "media.removeException": withCtx(media.removeException),
  "media.registerFiles": withExec(media.registerFiles),
  "relatedMedia.attach": withExec(related.attachMedia),
  "relatedMedia.detach": withExec(related.detachMedia),
  "relatedMedia.setType": withExec(related.setMediaType),
  "relatedMedia.setNotes": withExec(related.setMediaNotes),
  "relatedMedia.move": withExec(related.moveMedia),
  "relatedMedia.setPoster": withExec(related.setPoster),

  // assets and bundles
  "assets.applyImport": withExec(applyAssetImport),
  "assets.applyRelink": withExec(applyRelink),
  "bundle.create": withExec(createBundle),
  "bundle.addAssets": withExec(applyBundleAdd),
  "bundle.removeMember": withExec(removeBundleMember),
  "bundle.setMemberRole": withExec(setMemberRole),
  "bundle.bind": withCtx(bindBundle),
  "bundle.bindToCharacter": withCtx(bindBundleToCharacter),

  // checks
  "integrity.deletePropTag": withExec(integrity.deletePropTag),
  "integrity.reanchorPropTag": withExec(integrity.reanchorPropTag),
  "integrity.deleteBeat": withExec(integrity.deleteBeat),
  "integrity.unanchor": withCtx(integrity.unanchor),
  "integrity.unanchorBeat": withExec(integrity.unanchorBeat),
  "integrity.deleteSceneCharacter": withExec(integrity.deleteSceneCharacter),
  "mediaChecks.unifySpelling": withCtx(unifySpelling),
} as const;

export type CallName = keyof typeof CALLS;
export type CallArgs<K extends CallName> =
  (typeof CALLS)[K] extends Callable<infer A, unknown> ? A : never;
export type CallResult<K extends CallName> =
  (typeof CALLS)[K] extends Callable<infer _A, infer R> ? R : never;

/** Thrown for a name that is not in the table. */
export class UnknownCallError extends Error {
  constructor(name: string) {
    super(`unknown call: ${name}`);
    this.name = "UnknownCallError";
  }
}

export function callNames(): CallName[] {
  return Object.keys(CALLS) as CallName[];
}

/**
 * Run one named call against a session, as one write: serialised with
 * every other write, counted in the revision, and refused when the
 * caller's expected revision is stale.
 */
export async function callFn(
    session: Session, name: string, args: unknown,
    options: { expectedRevision?: number } = {}):
    Promise<{ result: unknown; revision: number }> {
  if (!Object.hasOwn(CALLS, name)) throw new UnknownCallError(name);
  if (!Array.isArray(args)) {
    throw new TypeError("arguments must be a list");
  }
  const callable = CALLS[name as CallName] as
    unknown as Callable<unknown[], unknown>;
  const result = await session.write(
    (ctx) => callable.run(ctx, args),
    options.expectedRevision === undefined
      ? {} : { expectedRevision: options.expectedRevision });
  return { result: result ?? null, revision: session.revision };
}
