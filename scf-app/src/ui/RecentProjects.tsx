// SPDX-License-Identifier: Apache-2.0
/**
 * RecentProjects.tsx — the start screen's history
 * (file-management-plan.md §3.5): every project `app.db` has seen,
 * most recently opened first. Missing files and missing asset roots
 * are marked, not hidden — the whole point of a history list is
 * seeing what is there before clicking it.
 *
 * Read-only: forgetting an entry is a Settings action (SettingsDialog's
 * Local data section), not this screen's — one place to edit app.db's
 * project history, not two that can disagree. `recentProjectsRevision`
 * is how this list learns Settings changed something while both were
 * mounted at once.
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectRow } from "@scf-host/appStore.ts";
import { useStore } from "../state/store.ts";
import { windowAppStore } from "../host/windowAppStore.ts";

interface Entry extends ProjectRow {
  fileMissing: boolean;
  /** Null when there is no asset root to check. */
  rootMissing: boolean | null;
}

async function withExistence(row: ProjectRow): Promise<Entry> {
  const [fileMissing, rootMissing] = await Promise.all([
    invoke<boolean>("fs_exists", { path: row.scfPath }).then((e) => !e),
    row.assetRoot === null ? Promise.resolve(null)
      : invoke<boolean>("fs_exists", { path: row.assetRoot })
        .then((e) => !e),
  ]);
  return { ...row, fileMissing, rootMissing };
}

export function RecentProjects(): JSX.Element | null {
  const openRecentProject = useStore((s) => s.openRecentProject);
  const recentProjectsRevision = useStore((s) => s.recentProjectsRevision);
  const [entries, setEntries] = useState<Entry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rows = await (await windowAppStore()).recentProjects();
      const withChecks = await Promise.all(rows.map(withExistence));
      if (!cancelled) setEntries(withChecks);
    })();
    return () => { cancelled = true; };
  }, [recentProjectsRevision]);

  if (entries === null || entries.length === 0) return null;

  return (
    <div className="recent-projects">
      <h2 className="recent-projects-title">Recent projects</h2>
      <ul>
        {entries.map((e) => (
          <li key={e.pathKey} className="recent-project-row">
            <button className="ghost recent-project-open"
                    disabled={e.fileMissing}
                    onClick={() => void openRecentProject(e.scfPath)}>
              <strong>{e.title ?? e.baseName ?? "Untitled"}</strong>
              <span className="muted small">{e.scfPath}</span>
              {e.fileMissing && (
                <span className="recent-project-flag">file not found</span>
              )}
              {!e.fileMissing && e.assetRoot !== null && (
                <span className="muted small">
                  {e.assetRoot}
                  {e.rootMissing === true && (
                    <span className="recent-project-flag">
                      {" "}folder not found
                    </span>
                  )}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
