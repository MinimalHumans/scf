// SPDX-License-Identifier: Apache-2.0
import { useEffect } from "react";
import { useStore, type NavMode } from "../../state/store.ts";
import logoMinimalHumansM from "../../assets/minimalHumans_logoM.svg";

interface Section {
  mode: NavMode;
  label: string;
  /** Not built yet: shown so the shape of the app is visible, not clickable. */
  pending?: string;
  /** Left off Alt+digit, so adding it did not renumber the rest. */
  noShortcut?: boolean;
}

/**
 * The sections, top to bottom in the order the work tends to flow:
 * write it, develop who and what is in it, then the tools.
 *
 * Always visible rather than a dropdown — the core loop is Script ↔
 * Characters, and a dropdown would make every switch two clicks and
 * hide where you are.
 */
export const SECTION_GROUPS: Array<{
  name: string; sections: Section[];
  /** A group of one that names itself needs no heading above it. */
  hideName?: boolean;
}> = [
  // The baseline everything else hangs off, so first. No shortcut: Alt+1
  // has always been Script, and it stays Script.
  { name: "Project", hideName: true, sections: [
    { mode: "project", label: "Project", noShortcut: true },
  ] },
  { name: "Story", sections: [
    { mode: "script", label: "Script" },
    { mode: "structure", label: "Structure" },
    { mode: "shoot", label: "Shoot" },
  ] },
  { name: "Narrative elements", sections: [
    { mode: "characters", label: "Characters" },
    { mode: "locations", label: "Locations" },
    { mode: "props", label: "Props" },
  ] },
  { name: "Tools", sections: [
    { mode: "subject", label: "Subjects" },
    { mode: "queries", label: "Queries" },
    { mode: "schema", label: "Schema" },
    { mode: "assets", label: "Assets" },
  ] },
  // Read-only, made to leave the app: printed, exported, put on a
  // screen. No shortcuts — Alt+0 is already the tenth section above.
  { name: "Presentation", sections: [
    { mode: "screenplay", label: "Screenplay", noShortcut: true },
    { mode: "storyboard", label: "Storyboard", noShortcut: true },
    { mode: "shotlist", label: "Shot list", noShortcut: true },
    { mode: "gallery", label: "Gallery", noShortcut: true },
  ] },
];

/** Alt+1 … Alt+0, in list order. Ctrl+digit is the browser's own. */
const SHORTCUTS: NavMode[] = SECTION_GROUPS
  .flatMap((g) => g.sections).filter((s) => s.noShortcut !== true)
  .map((s) => s.mode);

export function ActivityBar(): JSX.Element {
  const { navMode, setNavMode, assetResolution } = useStore();
  // Fires on its own — unlike the menu badge, this isn't gated on the
  // folder being unset: a root that resolves fine but a file that moved
  // or got deleted belongs here too, since this is where the fix is.
  //
  // Only genuinely broken assets count: `missing` (should be there,
  // isn't) and `out-of-root` (points somewhere that can never resolve).
  // `unaddressed` (no root attached at all) is excluded on purpose — an
  // asset nothing has tried to resolve yet is not broken, it is simply
  // unmapped, and that is the menu badge's story to tell, not this
  // one's (same reasoning as IdentityPanel's own Assets tally: "listed,
  // not broken"). `unmaterialised` (a synced placeholder) is healthy.
  const counts = assetResolution?.counts ?? null;
  const brokenAssets = counts !== null &&
    counts.missing + counts["out-of-root"] > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const m = /^Digit(\d)$/.exec(e.code);
      if (m === null) return;
      const index = m[1] === "0" ? 9 : Number(m[1]) - 1;
      const mode = SHORTCUTS[index];
      const section = SECTION_GROUPS.flatMap((g) => g.sections)
        .find((s) => s.mode === mode);
      if (mode === undefined || section?.pending !== undefined) return;
      e.preventDefault();
      setNavMode(mode);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setNavMode]);

  let n = 0;
  return (
    <nav className="activity-bar" aria-label="Sections">
      {SECTION_GROUPS.map((g) => (
        <div key={g.name} className="activity-group" role="group"
             aria-label={g.name}>
          {g.hideName !== true && (
            <span className="activity-group-name">{g.name}</span>
          )}
          {g.sections.map((s) => {
            if (s.noShortcut !== true) n += 1;
            const key = n === 10 ? "0" : String(n);
            const active = navMode === s.mode;
            const flagged = s.mode === "assets" && brokenAssets;
            const baseTitle = s.pending ?? (s.noShortcut === true ? s.label
              : `${s.label} (Alt+${key})`);
            return (
              <button key={s.mode}
                      className={"activity-item" + (active ? " active" : "")}
                      aria-current={active ? "page" : undefined}
                      disabled={s.pending !== undefined}
                      title={flagged
                        ? `${baseTitle} — some assets are missing or ` +
                          "can't be located"
                        : baseTitle}
                      onClick={() => setNavMode(s.mode)}>
                <span className="activity-item-label">{s.label}</span>
                {flagged && (
                  <span className="activity-item-badge" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
      ))}
      <a className="activity-maker" href="https://www.minimalhumans.com"
         target="_blank" rel="noopener noreferrer" title="Minimal Humans">
        <img src={logoMinimalHumansM} alt="Minimal Humans" />
      </a>
    </nav>
  );
}
