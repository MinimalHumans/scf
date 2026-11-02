// SPDX-License-Identifier: Apache-2.0
import type { ToolId } from "../../state/tabs.ts";
import { DashboardPane } from "./DashboardPane.tsx";
import { EventLogView } from "./EventLogView.tsx";
import { SettingsPane } from "./SettingsPane.tsx";

/**
 * Every open tool tab's content, in place of a project's panels — all
 * of them stay mounted (just hidden) so switching tabs keeps scroll
 * position and in-progress state instead of remounting from scratch.
 * Cheap: unlike a second project tab, a tool tab has no backing file
 * or project state of its own to duplicate.
 */
export function ToolPane({ tools, active }: {
  tools: ToolId[];
  active: ToolId | "project";
}): JSX.Element {
  return (
    <>
      {tools.map((id) => (
        <main key={id} className="tool-pane" hidden={id !== active}>
          {id === "events" && <EventLogView />}
          {id === "settings" && <SettingsPane />}
          {id === "media" && <DashboardPane />}
        </main>
      ))}
    </>
  );
}
