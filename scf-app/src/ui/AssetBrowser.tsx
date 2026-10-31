// SPDX-License-Identifier: Apache-2.0
/**
 * AssetBrowser — navigating a project's assets (P4).
 *
 * Three things sit side by side, and none of them is the structure:
 *
 *   The path tree is a DERIVED view of the identifiers, and it lives in
 *   the nav rail with every other tab's navigation — Script has its
 *   scenes there, Schema its categories, so Assets has its paths.
 *   Clicking a folder sets a prefix filter; it is not a place you are
 *   "in", and nothing is stored to make it exist.
 *
 *   Facets compose. Format, root, orphaned, unaddressed and free text
 *   all narrow the same list at once, because a single imposed
 *   hierarchy is wrong for half its users.
 *
 *   Relink is plan-then-apply, on whatever prefix is selected. Bulk
 *   re-rooting is the common repair and a repair nobody can preview is
 *   one nobody will run on a thousand rows.
 *
 * The authored structure remains the bundle graph, which lives in the
 * bundles themselves and is deliberately not duplicated here. What IS
 * shown here is where that graph fails to reach anything — the media
 * checks toggle (MediaChecksPanel).
 */

import { call } from "../state/api.ts";
import { useEffect, useMemo, useState } from "react";
import {
  applyFilter, facetsOf, listAssets, orphanIds, pathTree, type AssetFilter,
  type AssetRow, type TreeNode,
} from "@scf-core/assetIndex.ts";
import { planRelink, type RelinkChange } from "@scf-core/assets.ts";
import { previewCapability } from "@scf-core/preview.ts";
import { planAssetImport, type ImportPlan } from "@scf-core/assetImport.ts";
import { pickAssetFiles, pickAssetFolder }
  from "../files/assetPicker.ts";
import {
  listBundles, planBundleAdd, type BundleSummary,
} from "@scf-core/bundling.ts";
import { exec, registry, useStore } from "../state/store.ts";
import { AssetThumb } from "./AssetThumb.tsx";
import { mediaFindingCount } from "@scf-core/ops/mediaChecks.ts";
import { assetStanding } from "@scf-core/assetStanding.ts";
import { StandingTag } from "./StandingTag.tsx";
import { useRememberedFlag } from "./useRememberedFlag.ts";
import { MediaChecksPanel, useMediaReport } from "./MediaChecksPanel.tsx";

function Folder({ node, depth, selected, onSelect }: {
  node: TreeNode; depth: number; selected: string;
  onSelect: (prefix: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(depth < 2);
  const hasChildren = node.children.length > 0;

  return (
    <li>
      <div className={`asset-folder${
        selected === node.prefix ? " selected" : ""}`}
           style={{ paddingLeft: `${depth * 10}px` }}>
        <button className="ghost tiny asset-folder-twist"
                onClick={() => setOpen((v) => !v)}
                disabled={!hasChildren}>
          {hasChildren ? (open ? "▾" : "▸") : "·"}
        </button>
        <button className="ghost tiny asset-folder-name"
                onClick={() => onSelect(node.prefix)}>
          {node.name === "" ? "all" : node.name}
        </button>
        <span className="muted">{node.totalCount}</span>
      </div>
      {open && hasChildren && (
        <ul>
          {node.children.map((child) => (
            <Folder key={child.prefix} node={child} depth={depth + 1}
                    selected={selected} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}

function Relink({ prefix, onDone }: {
  prefix: string; onDone: () => void;
}): JSX.Element {
  const [to, setTo] = useState(prefix);
  const [plan, setPlan] = useState<RelinkChange[] | null>(null);
  const [applied, setApplied] = useState(0);

  useEffect(() => { setTo(prefix); setPlan(null); setApplied(0); },
            [prefix]);

  return (
    <div className="asset-relink">
      <h4>Re-root</h4>
      <p className="muted">
        Every identifier starting <span className="mono">{prefix}</span>{" "}
        moves. Nothing on disk is touched — this rewrites addresses, not
        files.
      </p>
      <input className="mono" value={to} spellCheck={false}
             onChange={(e) => { setTo(e.target.value); setPlan(null); }} />
      <div className="asset-relink-actions">
        <button className="tiny"
                disabled={to === prefix || to.trim() === ""}
                onClick={() => {
                  void (async () => {
                    setPlan(await planRelink(exec, prefix, to));
                  })();
                }}>
          Preview
        </button>
        {plan !== null && plan.length > 0 && (
          <button className="tiny primary"
                  onClick={() => {
                    void (async () => {
                      setApplied(await call("assets.applyRelink", plan));
                      setPlan(null);
                      onDone();
                    })();
                  }}>
            Apply to {plan.length}
          </button>
        )}
      </div>
      {plan !== null && plan.length === 0 && (
        <p className="muted">Nothing matches that prefix.</p>
      )}
      {plan !== null && plan.length > 0 && (
        <ul className="asset-relink-plan">
          {plan.slice(0, 8).map((c) => (
            <li key={c.id} className="mono">{c.from} → {c.to}</li>
          ))}
          {plan.length > 8 && (
            <li className="muted">…and {plan.length - 8} more</li>
          )}
        </ul>
      )}
      {applied > 0 && (
        <p className="muted">{applied} identifiers rewritten.</p>
      )}
    </div>
  );
}

/**
 * The index, loaded once and shared by the rail and the main panel.
 *
 * Both halves need the same rows, and loading them twice would mean two
 * scans of the asset table and two orphan sweeps on every open.
 */
function useAssetIndex(): {
  assets: AssetRow[]; orphans: ReadonlySet<number>; loading: boolean;
  reload: () => void;
} {
  const { revision } = useStore();
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [orphans, setOrphans] = useState<ReadonlySet<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setAssets(await listAssets(exec));
      setOrphans(await orphanIds(exec, registry));
      setLoading(false);
    })();
  }, [revision, nonce]);

  return { assets, orphans, loading,
           reload: () => setNonce((n) => n + 1) };
}

/** The path tree and relink, for the nav rail. */
export function AssetPathRail(): JSX.Element {
  const { assets, loading, reload } = useAssetIndex();
  const { assetPrefix, setAssetPrefix } = useStore();
  const tree = useMemo(() => pathTree(assets), [assets]);

  if (loading) return <p className="rail-empty">Loading…</p>;
  if (assets.length === 0) {
    return <p className="rail-empty">No assets yet.</p>;
  }

  return (
    <div className="asset-tree">
      <h4>Paths</h4>
      <p className="muted">
        Derived from the identifiers. Nothing here is authored.
      </p>
      <ul>
        <Folder node={tree} depth={0} selected={assetPrefix}
                onSelect={setAssetPrefix} />
      </ul>
      {assetPrefix !== "" && (
        <Relink prefix={assetPrefix} onDone={reload} />
      )}
    </div>
  );
}

/**
 * Import: read a set of files the user picked, write rows.
 *
 * Nothing is copied or written to disk — what lands in the database is
 * an address (conventions §9). The plan is shown before anything is
 * created, because an import that turns out to duplicate four hundred
 * rows is not one anybody wants to discover afterwards.
 */
function ImportAssets({ onDone }: { onDone: () => void }): JSX.Element {
  const { assetRoot } = useStore();
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [outside, setOutside] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<number | null>(null);

  const root = assetRoot;

  if (root === null) {
    return (
      <p className="muted asset-import-note">
        Attach the project's asset folder to import assets — an identifier
        is addressed relative to it.
      </p>
    );
  }

  return (
    <div className="asset-import">
      {([["folder", "Add a folder…", pickAssetFolder],
         ["files", "Add files…", pickAssetFiles]] as const).map(
        ([key, label, pick]) => (
          <button key={key} className="tiny" disabled={busy}
                  onClick={() => {
                    void (async () => {
                      setBusy(true);
                      setCreated(null);
                      try {
                        const picked = await pick(root);
                        if (picked === null) return;
                        setOutside(picked.outsideRoot);
                        setPlan(await planAssetImport(
                          exec, picked.candidates));
                      } finally {
                        setBusy(false);
                      }
                    })();
                  }}>
            {label}
          </button>
        ))}

      {plan !== null && (
        <div className="asset-import-plan">
          <span className="muted">
            {plan.create.length} new · {plan.existing.length} already here
            {plan.rejected.length > 0 &&
              ` · ${plan.rejected.length} unusable`}
            {outside.length > 0 &&
              ` · ${outside.length} outside the project folder`}
          </span>
          {plan.create.length > 0 && (
            <button className="tiny primary" disabled={busy}
                    onClick={() => {
                      void (async () => {
                        setBusy(true);
                        const n = await call("assets.applyImport", plan.create);
                        setCreated(n);
                        setPlan(null);
                        setBusy(false);
                        onDone();
                      })();
                    }}>
              Import {plan.create.length}
            </button>
          )}
        </div>
      )}
      {created !== null && (
        <span className="muted">{created} assets added.</span>
      )}
    </div>
  );
}

/**
 * Put the current selection into a bundle.
 *
 * The batch case is the real one: after importing a folder, the act is
 * "these twenty into her visual identity", not twenty separate visits
 * to twenty forms. Assets already in the target are skipped rather than
 * duplicated, so an overlapping selection is safe to re-apply.
 */
function AddToBundle({ ids, onDone }: {
  ids: number[]; onDone: () => void;
}): JSX.Element {
  const [bundles, setBundles] = useState<BundleSummary[]>([]);
  const [target, setTarget] = useState<string>("");
  const [role, setRole] = useState("");
  const [newName, setNewName] = useState("");
  const [intent, setIntent] = useState("visual_identity");
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    void (async () => setBundles(await listBundles(exec)))();
  }, []);

  const run = (): void => {
    void (async () => {
      let bundleId: number;
      if (target === "new") {
        if (newName.trim() === "") return;
        bundleId = await call("bundle.create", newName.trim(), intent);
      } else {
        bundleId = Number(target);
      }
      const plan = await planBundleAdd(exec, bundleId, ids);
      await call("bundle.addAssets", bundleId, plan.add,
                           role.trim() === "" ? null : role.trim());
      setResult(
        `${plan.add.length} added` +
        (plan.already.length > 0
          ? `, ${plan.already.length} already there` : ""));
      setBundles(await listBundles(exec));
      onDone();
    })();
  };

  return (
    <div className="asset-bundle-add">
      <select value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">add {ids.length} to bundle…</option>
        {bundles.map((b) => (
          <option key={b.id} value={String(b.id)}>
            {b.name ?? `#${b.id}`} ({b.intent ?? "no intent"}, {
              b.assetCount})
          </option>
        ))}
        <option value="new">new bundle…</option>
      </select>

      {target === "new" && (
        <>
          <input placeholder="bundle name" value={newName}
                 onChange={(e) => setNewName(e.target.value)} />
          <input placeholder="intent" value={intent}
                 title="What the media cascade filters on. A bundle with
no intent resolves for nothing."
                 onChange={(e) => setIntent(e.target.value)} />
        </>
      )}
      {target !== "" && (
        <>
          <input placeholder="role (optional)" value={role}
                 onChange={(e) => setRole(e.target.value)} />
          <button className="tiny primary" onClick={run}>Add</button>
        </>
      )}
      {result !== null && <span className="muted">{result}</span>}
    </div>
  );
}

const PAGE = 300;

export function AssetBrowser(): JSX.Element {
  const { openEntityRow, assetPrefix, setAssetPrefix, assetRoot,
          assetRootStatus, attachFolder } = useStore();
  const folderPrompt = assetRootStatus === "ok" ? null : (
    <div className={`asset-folder-prompt asset-folder-prompt-${
      assetRootStatus === "missing" ? "blocker" : "warn"}`}>
      <span>
        {assetRoot === null
          ? "No project folder is set, so asset files can't be located."
          : `${assetRoot} could not be found — it may have moved, or be ` +
            "on a drive that isn't connected right now."}
      </span>
      <button className="tiny" onClick={() => void attachFolder()}>
        {assetRoot === null ? "Choose folder…" : "Choose again…"}
      </button>
    </div>
  );
  const { assets, orphans, loading, reload } = useAssetIndex();
  const [filter, setFilter] = useState<AssetFilter>({});
  const [shownCount, setShownCount] = useState(PAGE);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [showChecks, setShowChecks] = useState(false);
  const mediaReport = useMediaReport();
  const mediaCount = mediaFindingCount(mediaReport);

  const [hideHistoric, setHideHistoric] =
    useRememberedFlag("scf:assets-hide-historic");

  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])),
                       [assets]);
  const standingOf = (a: AssetRow): ReturnType<typeof assetStanding> => {
    const next = a.supersededById == null ? undefined
      : byId.get(a.supersededById);
    return assetStanding(a.lifecycleStatus, !orphans.has(a.id),
                         next === undefined ? null
                           : (next.name ?? next.identifier ?? `#${String(next.id)}`));
  };
  const historicIds = useMemo(() => new Set(assets
    .filter((a) => assetStanding(a.lifecycleStatus, true).historic)
    .map((a) => a.id)), [assets]);
  // "Unreferenced" is the rot finder, and a superseded file nothing
  // points at is not rot — it is the history the chain was kept for.
  const liveOrphans = useMemo(() => new Set(
    [...orphans].filter((id) => !historicIds.has(id))),
  [orphans, historicIds]);

  const facets = useMemo(() => facetsOf(assets, liveOrphans),
                         [assets, liveOrphans]);
  const shown = useMemo(
    () => applyFilter(assets, { ...filter, prefix: assetPrefix },
                      liveOrphans)
      .filter((a) => !hideHistoric || !historicIds.has(a.id)),
    [assets, filter, assetPrefix, liveOrphans, hideHistoric, historicIds]);

  if (loading) return <div className="asset-browser">Loading assets…</div>;

  if (assets.length === 0) {
    return (
      <div className="asset-browser asset-browser-empty">
        {folderPrompt}
        <h3>No assets yet</h3>
        <p className="muted">
          An asset is a reference to something outside this file — an
          image, a recording, a model weight. What gets stored is an
          address like <span className="mono">@project/assets/x.png</span>,
          resolved against the project folder. Nothing is copied.
        </p>
        <ImportAssets onDone={reload} />
      </div>
    );
  }

  const toggle = (key: "orphansOnly" | "unaddressedOnly"): void =>
    setFilter((f) => ({ ...f, [key]: f[key] === true ? undefined : true }));

  return (
    <div className="asset-browser">
      {folderPrompt}
      <div className="asset-main">
        <div className="asset-filters">
          <input placeholder="filter by name or identifier"
                 value={filter.text ?? ""}
                 onChange={(e) =>
                   setFilter((f) => ({ ...f, text: e.target.value }))} />
          <button className={`tiny${
            filter.orphansOnly === true ? " primary" : ""}`}
                  onClick={() => toggle("orphansOnly")}
                  title="Assets nothing points at — no bundle, no anchor,
no relationship. These are what rot at scale.">
            unreferenced {facets.orphans}
          </button>
          <button className={`tiny${
            filter.unaddressedOnly === true ? " primary" : ""}`}
                  onClick={() => toggle("unaddressedOnly")}>
            no identifier {facets.unaddressed}
          </button>
          {historicIds.size > 0 && (
            <button className={`tiny${hideHistoric ? " primary" : ""}`}
                    onClick={() => setHideHistoric(!hideHistoric)}
                    title="Hide superseded, cut, archived and deprecated
files: history kept for the record, not the versions meant now.">
              hide historic {historicIds.size}
            </button>
          )}
          <button className={`tiny${showChecks ? " primary" : ""}`}
                  onClick={() => setShowChecks((v) => !v)}
                  title="Bundles bound to nothing, bindings in force at every
scene, audio filed as picture, one value spelled several ways, JSON
fields that hold no JSON.">
            media checks {mediaCount}
          </button>
          {assetPrefix !== "" && (
            <button className="ghost tiny"
                    onClick={() => setAssetPrefix("")}>
              clear path: <span className="mono">{assetPrefix}</span>
            </button>
          )}
        </div>

        {showChecks && <MediaChecksPanel report={mediaReport} />}

        <div className="asset-facets">
          {facets.formats.slice(0, 12).map((f) => (
            <button key={f.value}
                    className={`ghost tiny${
                      filter.format === f.value ? " primary" : ""}`}
                    onClick={() => setFilter((prev) => ({
                      ...prev,
                      format: prev.format === f.value
                        ? undefined
                        : (f.value === "no extension" ? null : f.value),
                    }))}>
              {f.value} {f.count}
            </button>
          ))}
        </div>

        <div className="asset-count">
          <span className="muted">{shown.length} of {facets.total}</span>
          <ImportAssets onDone={reload} />
          {selected.size > 0 && (
            <>
              <AddToBundle ids={[...selected]}
                           onDone={() => setSelected(new Set())} />
              <button className="ghost tiny"
                      onClick={() => setSelected(new Set())}>
                clear selection
              </button>
            </>
          )}
          {shown.length > 0 && selected.size === 0 && (
            <button className="ghost tiny"
                    onClick={() => setSelected(
                      new Set(shown.map((a) => a.id)))}>
              select all {shown.length}
            </button>
          )}
        </div>

        <ul className="asset-list">
          {shown.slice(0, shownCount).map((a) => {
            const standing = standingOf(a);
            return (
            <li key={a.id} className={"asset-row" +
              (standing.historic ? ` asset-row-historic asset-row-${standing.kind}` : "")}>
              <input type="checkbox" className="asset-row-check"
                     aria-label={`select ${a.name ?? a.id}`}
                     checked={selected.has(a.id)}
                     onChange={() => setSelected((prev) => {
                       const next = new Set(prev);
                       if (next.has(a.id)) next.delete(a.id);
                       else next.add(a.id);
                       return next;
                     })} />
              <AssetThumb identifier={a.identifier} size="sm"
                          alt={a.name ?? "unnamed"}
                          onClick={() => {
                            void openEntityRow("asset", a.id);
                          }} />
              <button className="ghost tiny asset-row-name"
                      onClick={() => { void openEntityRow("asset", a.id); }}>
                {a.name ?? "unnamed"}
              </button>
              <span className="mono asset-row-id">
                {a.identifier ?? "no identifier"}
              </span>
              {previewCapability(a.format).tier !== "native" && (
                <span className="asset-row-tier"
                      title={previewCapability(a.format).detail ?? ""}>
                  {previewCapability(a.format).tier === "decoded"
                    ? "no decoder" : "not viewable"}
                </span>
              )}
              <StandingTag standing={standing}
                           onOpenSuccessor={a.supersededById == null
                             ? undefined
                             : () => void openEntityRow(
                                 "asset", a.supersededById as number)} />
            </li>
            );
          })}
          {shown.length > shownCount && (
            <li className="asset-more">
              <button className="tiny"
                      onClick={() => setShownCount((n) => n + PAGE)}>
                Show {Math.min(PAGE, shown.length - shownCount)} more
              </button>
              <button className="ghost tiny"
                      onClick={() => setShownCount(shown.length)}>
                Show all {shown.length}
              </button>
              <span className="muted">
                {shown.length - shownCount} not shown — rendering is
                capped for speed, not because the rest are missing.
              </span>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
