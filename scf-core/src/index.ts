// SPDX-License-Identifier: Apache-2.0
/**
 * scf-core — SCF (Story Context Framework) core library.
 *
 * THIS IS THE PUBLIC SURFACE, and it is an explicit list rather than a
 * barrel of `export *`.
 *
 * A barrel of `export *` gives the package no stated surface at all:
 * every helper written for internal use is exported by accident, and
 * nothing distinguishes a name meant for consumers from one that
 * happens to be reachable. That costs nothing while the package is
 * unpublished and becomes a compatibility obligation the moment
 * somebody installs it, because a name a consumer CAN import is a name
 * they WILL import.
 *
 * WHAT IS HERE, AND WHY THESE.
 *
 * The organising question is not "what does the editor use" — `scf-app`
 * imports modules directly through a path alias and has never gone
 * through this file. It is "what does someone implementing the format
 * from `spec/conformance.md` need". The sections below follow that
 * document's three roles, so a reader can see which claim each group
 * serves.
 *
 * WHAT IS NOT HERE.
 *
 * Four modules are editor tooling rather than the format, and appear in
 * no conformance role, no query result and no published artifact:
 *
 *   assetIndex   browsing, facets and the derived path tree
 *   preview      display tiers for the editor's preview pane
 *   assetImport  import candidate plans and relink plans
 *   bundling     bundle mutation helpers
 *
 * They remain importable by deep path for anyone who needs them, and
 * `scf-app` continues to import them exactly as before. They are simply
 * not part of what this package promises to keep working.
 *
 * `spec/api-surface.json` records what this file exposes, CI checks it,
 * and the same check enforces that **every type named in a public
 * signature is itself public** — so a consumer can always write down
 * what a function gave them.
 *
 * Node driver lives in "./node" (separate export; never imported here
 * so browser bundles stay clean).
 */

// ── The registry ─────────────────────────────────────────────────
// Spec §2. The field set every consumer reads before anything else.
export {
  type EntityDef, type FieldDef, type FieldType, type FrameworkColumn,
  type PositionPattern, type Registry, type RegistryJson,
  cascadeChain, loadRegistry, polymorphicKindsFor, polymorphicTarget,
} from "./registry.ts";

// ── Opening a file ───────────────────────────────────────────────
// Spec §1.2, §1.3, §6.1. The SqlExec seam is the whole portability
// story: give it a driver and everything above works unchanged.
export {
  type InitOptions, type Row, type SqlExec, type SqlValue,
  initDatabase, newUuid, q, readMeta, tableColumns, withTransaction,
} from "./db.ts";

// A session is one open file plus the bookkeeping writers share: what is
// unsaved, how to save, whether the file moved. `openNodeSession` in
// "./node" is the file-backed driver.
export {
  type Session, type SessionDriver, type SessionOptions, type SessionState,
  type WriteOptions, StaleRevisionError, createSession,
} from "./session.ts";

// The named writes a client may ask the host for. Plain-data arguments in,
// plain data out: the same table serves the window, the MCP and scripts.
export type {
  ScreenplayRow, TitlePageRow,
} from "./screenplay/rowModel.ts";
export {
  type GateFinding, type GateNote, IntegrityGateError, currentFindings,
  currentNotes, dryRunThroughGate, withIntegrityGate,
} from "./ops/integrityGate.ts";
export {
  type DanglingReference, danglingReferences,
} from "./references.ts";
export { rowLabel } from "./displayName.ts";
export type { PreviewKind } from "./preview.ts";

// Reads that used to live in the editor. One implementation each, so the
// window and an MCP client ask the same question and get the same answer.
export {
  type QueryId, type MarkdownRenderer, QUERY_IDS, isQueryId, queryMarkdown,
} from "./queryMarkdown.ts";
export {
  type GalleryFilter, type GalleryItem, type GallerySort, type Use,
  type GallerySubjectKind,
  describeUses, filterItems, loadGallery, sortItems,
} from "./gallery.ts";
export {
  type BeatGroup, type SceneSheet, type SheetOptions, type ShotlistRows,
  actionText, beatBanner,
  buildSheets, readShotlistRows, runningTime, shortAngle, shortSize,
} from "./shotlist.ts";
export {
  type BoardRows, readBoardRows,
} from "./storyboard.ts";
export {
  type ScenePresence as CharacterScenePresence, type ScriptPresence,
  type Speech, presenceByScene, readScriptPresence,
} from "./characterPresence.ts";
export { TITLE_KEYS, titleSlot, type TitleKeyDef }
  from "./ops/titlePageOps.ts";
export {
  type CallArgs, type CallName, type CallResult, type Callable,
  type ScriptCommit, type ScriptImport, CALLS, UnknownCallError, callFn, callNames,
} from "./ops/calls.ts";
export {
  type ArgSpec, type ArgsSpec, type ArgType, type CallOptions, type OpDef,
  type OpResult, OpArgumentError, UnknownOpError,
  argsJsonSchema, callOp, getOp, listOps, validateArgs,
} from "./ops/opTable.ts";

export {
  type FileIdentity, SCF_APPLICATION_ID,
  decodeUserVersion, encodeUserVersion, fileIdentity, stampFileIdentity,
} from "./fileIdentity.ts";

export {
  type FileMetadata, type MetadataField, HEADER_BYTES, readHeaderMetadata,
} from "./fileMetadata.ts";

// ── Reader: order, structure and spans ───────────────────────────
// Spec §4.1, §5. Story order is derived here and never from
// scene_number alone.
export {
  type FindingLevel, type OutlineGroup, type ScenePosition, type Span,
  type Structure, type StructureFinding,
  SCENE_ORDER_BY, SCENE_ORDER_JOIN,
  actOf, actOutline, deriveStructure, orphanedScenes, sceneOrderHint,
  scenePositions, sequenceOf, storyOrder, structureFindings,
} from "./structure.ts";

export {
  type SceneNumberParts,
  compareSceneNumbers, parseSceneNumber, runIndex,
  sceneNumberOrderJoin, sceneNumberOrderTerms, sceneNumberSortKey,
} from "./sceneNumbers.ts";

// ── Reader: resolution ───────────────────────────────────────────
// Spec §4.5 (position patterns) and §7 (cascades, root-first).
export {
  type ResolvedDescription, type ResolvedMedia, type SceneOrder,
  type ScfContext, type TrailEntry, type TrailExclusion,
  type TrailExclusionCode,
  excludeCut, latestState, mergedModulations, motifStateAt, propStateAt,
  relationshipStateAt, resolveDescription, resolveDirection, resolveMedia,
  rows, rowsIncludingCut, sceneOrder, selectLocationVariant, statesInForce,
  trailEntryLine, trailLine, variantInForce,
} from "./resolution.ts";

export {
  type Direction, type RelationshipFinding, type RelationshipFindingKind,
  type RelationshipView, relationshipFindings, relationshipsFor,
} from "./relationships.ts";

// ── Reader: assets ───────────────────────────────────────────────
// Spec §8. Optional for the Reader role; a Reader that does not resolve
// assets reports every one as `unaddressed`.
export {
  type AssetIdentifier, type AssetResolution, type FileLocator,
  type LocatedFile, type RelinkChange, type Resolution,
  type ResolutionReport, type ResolutionState, PROJECT_ROOT,
  applyRelink, escapesRoot, formatOf, normalisePath, parseIdentifier,
  planRelink, projectIdentifier, resolveAllAssets, resolveIdentifier,
} from "./assets.ts";

export {
  type AssetReference, type MediaReferences, type Provenance,
  type ResolutionSummary,
  mediaReferences, referencesMarkdown, summaryLine,
} from "./mediaReferences.ts";

export {
  type RegionBox, type SubjectAnchor,
  parseRegionBox, regionFits, visualAnchorFor,
} from "./anchors.ts";

export {
  type ProjectFinding, type ProjectFindingKind, type ProjectPick,
  chooseProjectFile, isProjectFile,
} from "./project.ts";

export {
  baseNameOf, bumpVersionSuffix, stripVersionSuffix, withoutScfExtension,
} from "./projectName.ts";

// ── The queries ──────────────────────────────────────────────────
// Spec §12. Sixteen queries, each with a published normative result.
export {
  type ProjectedRow, type QueryResult, type UuidLookup,
  POLYMORPHIC, STRING_LIST, QUERY_RESULT_FORMAT,
  columnRoles, envelope, projectRow, uuidLookupFor, uuidLookupForAll,
} from "./queryResult.ts";

export {
  type DossierComposition, type DossierGroup, type DossierRelationship,
  type Q00Result, type Q01Result, type Q02Result, type Q03Composition,
  type Q03Result, type Q04Result, type Q05Result, type Q07Layer,
  type Q07Result, type Q09Result, type Q10Result, type Q11Result,
  type Q12Composition, type Q12Result, type Q13Reference, type Q13Result,
  type Q13TrailEntry,
  type Q14Result, type Q14Subject, type Q15Result,
  MOTIF_DENSITY_THRESHOLD,
  Q00_LAYERS, Q04_DETAIL, Q07_SCENE_LEAF, Q07_SHOT_LEAF, Q08_LEAF,
  Q11_LEAF,
  composeDossier, composeQ03, composeQ12, mentionsRow,
  q00Result, q01Result, q02Result, q03Result, q04Result, q05Result,
  q06Result, q07Result, q08Result, q09Result, q10Result, q11Result,
  q12Result, q13Result, q14Result, q15Result,
} from "./canonicalQueries.ts";

export {
  type QueryPath, type QueryStep, type Requirement, QUERY_PATHS,
} from "./queryPaths.ts";

export {
  type ReadinessFinding, type ReadinessParams, type ReadinessReport,
  type Severity, SEVERITY_ORDER, readinessReport,
} from "./readiness.ts";

// ── Reader: label lookup and the shot-context composite ──────────
// Not part of the sixteen (§12.0, §4.5 of docs/scf-mcp-design.md) —
// convenience for a caller that starts from a typed label rather than a
// uuid, and a composite of existing queries for one common request.
export {
  type KeyHit, labelFieldOf, resolveNaturalKey,
} from "./naturalKey.ts";

export {
  type PresentSubject, type RelatedAsset, type ShotContext,
  type ShotContextFormat, type ShotMedia, type ShotPresenceMember,
  type ShotReadiness, type SweptSubject, shotContext, shotMedia,
  shotReadiness,
} from "./shotContext.ts";

export {
  type LineAnchorField, type LineProblem, type OrphanedAnchor,
  type RangeVerdict, lineAnchorFields, lineProblems, liveLineUuids,
  orphanedAnchors, rangeEntities, rangeLines, rangeSceneField,
} from "./lines.ts";

export {
  type Presence, type PresenceProblem, type PresenceSubject,
  type ScenePresence, type ShotPresence, type ShotSubject,
  presenceAtScene, presenceAtShot, presenceProblems, valuePresence,
} from "./presence.ts";

export {
  type ListFilter, type ListedRow, listEntities,
} from "./listEntities.ts";

export { type Usage, whereUsed } from "./whereUsed.ts";

// ── Writer: identity and numbering ───────────────────────────────
// Spec §6.1–6.4, §3.3, §4.3, §4.4.
export {
  type IdentityAudit, type IdentityFinding, type IdentityFindingKind,
  type NaturalKeyPart, type RowIdentity, type TableIdentity,
  type UuidHit, type UuidRow, type VersionLink,
  auditIdentity, browseUuids, findByUuid, isUuidShaped, rowIdentity,
} from "./identity.ts";

export {
  type DuplicateJunction,
  duplicateJunctions, junctionEntities, junctionKeyFields,
} from "./junctions.ts";

export {
  type NumberingPolicy, DEFAULT_NUMBERING_POLICY,
  numberingPolicy, numberingPolicyOf, setNumberingPolicy,
} from "./numbering.ts";

export {
  letterIndex, nextShotNumber, parseShotCode, restampShotNumber,
  shotCode, shotLetter,
} from "./shots.ts";

// ── The validator ────────────────────────────────────────────────
// Spec §9. A file that is merely wrong is expected input: the answer is
// a finding, never a refusal.
export {
  type Finding, type FindingCode, type FindingReport,
  type FindingSeverity, type FindingSpec,
  FINDING_CATALOG, FINDING_SEVERITY_RANK, collectFindings, sortFindings,
} from "./findings.ts";

export {
  type ReportFinding, type ReportOptions, type ValidationReport,
  REPORT_FORMAT_VERSION, renderReport, validationReport,
} from "./report.ts";

// ── Writer: round-trip integrity ─────────────────────────────────
// Spec conformance.md §3. The canonical dump is what open-save-lose-
// nothing is actually compared on, so a Writer claiming the role needs
// it to make the claim.
export {
  type CanonicalDump, type DumpDifference, type DumpOptions,
  canonicalDump, diffDumps, dumpToJson,
} from "./canonical.ts";
