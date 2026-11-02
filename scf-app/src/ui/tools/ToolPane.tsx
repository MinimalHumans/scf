// SPDX-License-Identifier: Apache-2.0
import type { ToolId } from "../../state/tabs.ts";
import { EventLogView } from "./EventLogView.tsx";
import { SettingsPane } from "./SettingsPane.tsx";

/** The front tool tab's content, in place of a project's panels. */
export function ToolPane({ id }: { id: ToolId }): JSX.Element {
  return (
    <main className="tool-pane">
      {id === "events" && <EventLogView />}
      {id === "settings" && <SettingsPane />}
    </main>
  );
}
