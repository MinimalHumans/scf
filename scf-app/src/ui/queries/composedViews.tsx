// SPDX-License-Identifier: Apache-2.0
/**
 * composedViews.tsx — human views of the composed queries' normative
 * results. Rows arrive projected (§12.1.2): `{ uuid, fields }`, so a
 * link opens its row by uuid.
 */
import type { ProjectedRow } from "@scf-core/queryResult.ts";
import {
  Q00_LAYERS,
  type Q00Result, type Q01Result, type Q02Result, type Q04Result,
  type Q09Result, type Q10Result, type Q11Result, type Q15Result,
} from "@scf-core/canonicalQueries.ts";
import { openEntityByUuid, registry } from "../../state/store.ts";
import { AuthoredFields } from "./QueryRunner.tsx";
import { field, nameOf } from "./fields.ts";

function EntityHeading({ entity }: { entity: string }): JSX.Element {
  const edef = registry.entities.get(entity);
  return (
    <h3>
      {edef?.icon} {edef?.label ?? entity}
    </h3>
  );
}

function RowLink({ entity, row }: {
  entity: string; row: ProjectedRow;
}): JSX.Element {
  return (
    <button className="row-link"
            onClick={() => void openEntityByUuid(entity, row.uuid)}>
      {nameOf(row)}
    </button>
  );
}

/** Seen is the plain case; heard or mentioned is worth a tag. */
function PresenceTags({ presence, variant }: {
  presence: string | null; variant: ProjectedRow | null;
}): JSX.Element {
  return (
    <>
      {presence !== null && presence !== "seen" && (
        <span className="scope-tag">{presence}</span>
      )}
      {variant !== null && (
        <span className="scope-tag">as {nameOf(variant)}</span>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

export function BriefView({ p }: { p: Q00Result }): JSX.Element {
  const layers = new Map(p.layers.map((l) => [l.entity, l.row]));
  return (
    <div className="qview brief">
      {Q00_LAYERS.map((entity) => {
        const row = layers.get(entity);
        return (
          <section key={entity} className="brief-layer">
            <EntityHeading entity={entity} />
            {row !== undefined
              ? <AuthoredFields entity={entity} row={row} />
              : <p className="muted">not yet authored</p>}
          </section>
        );
      })}
      {p.posters.length > 0 && (
        <section className="brief-layer">
          <h3>Poster</h3>
          <ul className="qlist">
            {p.posters.map((a, i) => (
              <li key={a.uuid ?? i}>
                {nameOf(a, "asset")}
                {i > 0 && <span className="scope-tag">alternative</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="brief-layer">
        <h3>Themes</h3>
        <ul className="qlist">
          {p.themes.map((t, i) => (
            <li key={t.uuid ?? i}>
              <b>{nameOf(t)}</b>
              {field(t, "description") !== null && (
                <span className="muted"> — {field(t, "description")}</span>
              )}
            </li>
          ))}
          {p.themes.length === 0 && (
            <li className="muted">no themes declared</li>
          )}
        </ul>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function DossierView({ p }: { p: Q01Result }): JSX.Element {
  return (
    <div className="qview">
      {p.groups.map((g) => (
        <section key={g.entity}>
          <EntityHeading entity={g.entity} />
          <ul className="qlist">
            {g.rows.map((r, i) => (
              <li key={r.uuid ?? i} className="dossier-row">
                <RowLink entity={g.entity} row={r} />
                <AuthoredFields entity={g.entity} row={r} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {p.groups.length === 0 && (
        <p className="muted">No global-scope depth entities authored for
           this subject yet.</p>
      )}
      {p.motifCarriage.length > 0 && (
        <section>
          <h3>Motif carriage</h3>
          <ul className="qlist">
            {p.motifCarriage.map((m, i) => (
              <li key={m.appearance.uuid ?? i}>
                {nameOf(m.motif, "motif")}
                {field(m.appearance, "domain") !== null && (
                  <span className="scope-tag">
                    {field(m.appearance, "domain")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {p.thematicConnections.length > 0 && (
        <section>
          <h3>Thematic connections</h3>
          <ul className="qlist">
            {p.thematicConnections.map((t, i) => (
              <li key={t.uuid ?? i}>
                {field(t, "nature_of_connection") ?? "connected"}
                <span className="scope-tag">
                  subtlety: {field(t, "subtlety_level") ?? "—"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {p.relationships.length > 0 && (
        <section>
          <h3>Relationships</h3>
          <ul className="qlist">
            {p.relationships.map((r, i) => (
              <li key={r.relationship.uuid ?? i}>
                {r.other === null
                  ? <span className="muted">someone not in this file</span>
                  : <RowLink entity="character" row={r.other} />}
                {field(r.relationship, "relationship_type") !== null && (
                  <span className="scope-tag">
                    {field(r.relationship, "relationship_type")}
                  </span>
                )}
                {/* a_to_b runs A to B (spec §6.5): read it from the
                    subject's own end. */}
                <span className="scope-tag">
                  {field(r.relationship, "directionality") === "a_to_b"
                    ? (r.side === "a" ? "to them" : "from them")
                    : field(r.relationship, "directionality") ?? "—"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface StackLayer {
  scope: string;
  label: string;
  body: JSX.Element;
}

function RowCards({ entity, rows }: {
  entity: string; rows: ProjectedRow[];
}): JSX.Element {
  return rows.length > 0 ? (
    <ul className="qlist">
      {rows.map((r, i) => (
        <li key={r.uuid ?? i} className="dossier-row">
          <b>{nameOf(r)}</b>
          <AuthoredFields entity={entity} row={r} />
        </li>
      ))}
    </ul>
  ) : <p className="muted">none — well-defined absence</p>;
}

/**
 * Q02 as the context stack it describes: the dossier first, what the
 * scene changes after it, media last — most specific wins.
 */
export function ContextStackView({ p }: { p: Q02Result }): JSX.Element {
  const stack: StackLayer[] = [{
    scope: "global", label: "Dossier (global baseline)",
    body: (
      <ul className="qlist">
        {p.dossier.groups.map((g) => (
          <li key={g.entity}>
            <span className="cascade-entity">{g.entity}</span>{" "}
            {g.rows.map((r) => nameOf(r)).join(", ")}
          </li>
        ))}
        {p.dossier.groups.length === 0 && (
          <li className="muted">nothing authored</li>
        )}
      </ul>
    ),
  }];
  const rows = (scope: string, label: string, entity: string,
                list: ProjectedRow[]): void => {
    stack.push({ scope, label,
                 body: <RowCards entity={entity} rows={list} /> });
  };
  if (p.subjectType === "character") {
    rows("scene", "Variant in force", "character_variant",
         p.characterVariant === null ? [] : [p.characterVariant]);
    rows("scene", "Costume in force", "costume", p.costumes);
    stack.push({
      scope: "scene", label: "Relationship state as of here",
      body: p.relationshipStates.length > 0 ? (
        <ul className="qlist">
          {p.relationshipStates.map((r, i) => (
            <li key={r.uuid ?? i}>
              {field(r, "stage_label") ?? nameOf(r)}
            </li>
          ))}
        </ul>
      ) : <p className="muted">none — well-defined absence</p>,
    });
    rows("scene", "Arc stage as of here", "character_arc_state",
         p.arcStates);
    rows("scene", "Performance states in force", "performance_state",
         p.performanceStates);
    rows("moment", "Moment direction (beats)", "performance_beat",
         p.beats);
  }
  if (p.subjectType === "location" && p.locationVariant !== null) {
    const v = p.locationVariant;
    rows("scene",
         "Variant in force" + (v.mismatches.length > 0
           ? ` — mismatches: ${v.mismatches.join("; ")}` : ""),
         "location_variant", v.variant === null ? [] : [v.variant]);
  }
  if (p.subjectType === "prop") {
    rows("scene", "Variant in force", "prop_variant",
         p.propVariant === null ? [] : [p.propVariant]);
    rows("scene", "Prop state as of here", "prop_state",
         p.propState === null ? [] : [p.propState]);
  }
  stack.push({
    scope: p.media.references.some((r) => r.provenance === "shot override")
      ? "shot" : "scene",
    label: `Media in force (${p.media.fromQuery}, ` +
           `intent=${p.media.intent})`,
    body: (
      <ul className="qlist">
        {p.media.references.map((r, i) => (
          <li key={r.uuid ?? i}>
            {r.name ?? r.anchorName ?? "asset"}
            <span className="scope-tag">{r.provenance}</span>
          </li>
        ))}
        {p.media.references.length === 0 && (
          <li className="muted">nothing resolves</li>
        )}
      </ul>
    ),
  });
  return (
    <div className="qview">
      <p className="muted">
        Resolve down, most specific wins, everything above is context.
      </p>
      <ol className="cascade">
        {stack.map((layer, i) => (
          <li key={i} className={i === stack.length - 1 ? "in-force" : ""}>
            <div className="cascade-head">
              <span className="cascade-entity">{layer.scope}</span>
              <span className="cascade-name">{layer.label}</span>
              {i === stack.length - 1 && (
                <span className="in-force-tag">most specific</span>
              )}
            </div>
            {layer.body}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function PackageView({ p }: { p: Q04Result }): JSX.Element {
  const v = p.locationVariant;
  return (
    <div className="qview">
      {p.lineage.length > 0 && (
        <p className="lineage">
          {p.lineage.map((l) => `${l.entity}: ${nameOf(l.row)}`)
            .join("  ›  ")}
          {"  ›  "}
          <b>{nameOf(p.scene)}</b>
        </p>
      )}
      <h3>Story beats</h3>
      <ol className="qlist">
        {p.storyBeats.map((b, i) => (
          <li key={b.uuid ?? i}>
            <b>{nameOf(b)}</b>
            <span className="scope-tag">
              {field(b, "beat_type") ?? "beat"}
            </span>
            {field(b, "value_shift") !== null && (
              <span className="muted">{field(b, "value_shift")}</span>
            )}
          </li>
        ))}
        {p.storyBeats.length === 0 && (
          <li className="muted">no beats authored</li>
        )}
      </ol>
      <h3>Cast & props</h3>
      <ul className="qlist">
        {p.cast.map((c, i) => (
          <li key={`c${c.character.uuid ?? i}`}>
            <RowLink entity="character" row={c.character} />
            <PresenceTags presence={c.presence} variant={c.variant} />
          </li>
        ))}
        {p.props.map((x, i) => (
          <li key={`p${x.prop.uuid ?? i}`}>
            <RowLink entity="prop" row={x.prop} />
            <span className="scope-tag">prop</span>
            <PresenceTags presence={x.presence} variant={x.variant} />
          </li>
        ))}
      </ul>
      <h3>Location</h3>
      {p.location !== null ? (
        <p>
          {nameOf(p.location)}
          {v.variant !== null && (
            <>
              {" — variant in force: "}<b>{nameOf(v.variant)}</b>
            </>
          )}
          {v.mismatches.map((m) => (
            <span key={m} className="invalid-note"> {m}</span>
          ))}
        </p>
      ) : <p className="muted">no location set</p>}
      {p.detail.map((d) => (
        <section key={d.entity}>
          <EntityHeading entity={d.entity} />
          {d.rows.map((r, i) => (
            <div key={r.uuid ?? i} className="dossier-row">
              <b>{nameOf(r)}</b>
              <AuthoredFields entity={d.entity} row={r} />
            </div>
          ))}
        </section>
      ))}
      <h3>Staging</h3>
      {p.blocking.length > 0 ? (
        <ul className="qlist">
          {p.blocking.map((b, i) => <li key={b.uuid ?? i}>{nameOf(b)}</li>)}
          {p.stagingBeats.map((b, i) => (
            <li key={`sb${b.uuid ?? i}`} className="muted">
              beat {field(b, "beat_order") ?? ""}:{" "}
              {field(b, "name") ?? field(b, "description") ?? ""}
            </li>
          ))}
        </ul>
      ) : <p className="muted">no blocking authored</p>}
      <h3>Screenplay</h3>
      {p.screenplay.length > 0 ? (
        <div className="scene-script">
          {p.screenplay.map((l, i) => (
            <p key={l.uuid ?? i}
               className={`sl sl-${field(l, "line_type") ?? "action"}`}>
              {field(l, "content") ?? ""}
            </p>
          ))}
        </div>
      ) : (
        <p className="muted">
          no lines — the screenplay has not reached this scene
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function ManifestView({ p }: { p: Q09Result }): JSX.Element {
  return (
    <div className="qview">
      {p.dense && (
        <p className="density-warning">
          {p.manifest.length} motifs in one scene — above the density
          threshold ({p.densityThreshold}, heuristic). Meaning competes.
        </p>
      )}
      <table className="qtable">
        <thead>
          <tr>
            <th>motif</th><th>domain</th><th>subtlety (as of here)</th>
            <th>notes</th>
          </tr>
        </thead>
        <tbody>
          {p.manifest.map((m, i) => (
            <tr key={m.appearance.uuid ?? i}>
              <td>{nameOf(m.motif, "motif")}</td>
              <td>{field(m.appearance, "domain") ?? "—"}</td>
              <td>{field(m.state, "subtlety_level") ??
                   field(m.motif, "subtlety_level") ?? "—"}</td>
              <td className="muted">
                {field(m.appearance, "manifestation_notes") ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {p.manifest.length === 0 && (
        <p className="muted">No motifs placed here.</p>
      )}
      {p.candidates.length > 0 && (
        <>
          <h3>Cross-modality candidates</h3>
          <ul className="qlist">
            {p.candidates.map((c, i) => (
              <li key={c.uuid ?? i}>
                {nameOf(c)}
                <span className="muted"> — related to a motif in frame,
                  not yet placed</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function AccountingView({ p }: { p: Q10Result }): JSX.Element {
  const max = Math.max(1, ...p.spine.map((s) => s.carriers));
  return (
    <div className="qview">
      <h3>Distribution across the spine</h3>
      <div className="spine accounting-spine" role="img"
           aria-label="theme carriage per scene">
        {p.spine.map((s) => (
          <span key={s.sceneUuid}
                title={`sc ${s.sceneNumber ?? "?"}: ` +
                       `${s.carriers} carrier(s)`}
                className={"spine-cell" + (s.carriers > 0 ? " keyed" : "")}
                style={{ opacity: s.carriers > 0
                  ? 0.45 + 0.55 * (s.carriers / max) : 1 }} />
        ))}
      </div>
      <h3>Carriers</h3>
      <table className="qtable">
        <thead>
          <tr><th>target</th><th>connection</th><th>scenes</th></tr>
        </thead>
        <tbody>
          {p.carriers.map((c, i) => (
            <tr key={c.connection.uuid ?? i}>
              <td>{c.targetEntity}: {c.targetName ?? "?"}</td>
              <td>{field(c.connection, "nature_of_connection") ??
                   "connected"}</td>
              <td>{c.sceneUuids.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {p.carriers.length === 0 && (
        <p className="muted">This theme has no declared carriers —
           aspiration, not presence.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function AudienceView({ p }: { p: Q11Result }): JSX.Element {
  const id = p.identification;
  return (
    <div className="qview">
      <h3>Known / withheld</h3>
      {p.information !== null
        ? <AuthoredFields entity="information_strategy"
                          row={p.information} />
        : <p className="muted">No information strategy authored.</p>}
      <h3>Identification</h3>
      {id !== null ? (
        <>
          <p>
            Primary: <b>{nameOf(id.primary)}</b>
            {id.secondary !== null && (
              <> · Secondary: {nameOf(id.secondary)}</>
            )}
          </p>
          <AuthoredFields entity="identification_strategy" row={id.row} />
        </>
      ) : <p className="muted">No identification strategy authored.</p>}
      {p.emotionalBeats.length > 0 && (
        <>
          <h3>Emotional beats</h3>
          <ul className="qlist">
            {p.emotionalBeats.map((e, i) => (
              <li key={e.beat.uuid ?? i}>
                <b>{field(e.beat, "target_emotion") ?? nameOf(e.beat)}</b>
                {e.arc !== null && (
                  <span className="scope-tag">arc: {nameOf(e.arc)}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {p.toneMarkers.length > 0 && (
        <>
          <h3>Tone</h3>
          {p.toneMarkers.map((t, i) => (
            <div key={t.uuid ?? i} className="dossier-row">
              <b>{field(t, "tone_descriptor") ?? nameOf(t)}</b>
              <AuthoredFields entity="tone_marker" row={t} />
            </div>
          ))}
        </>
      )}
      <h3>Emotional direction cascade</h3>
      <ol className="cascade">
        {p.emotionalCascade.map((l, i) => (
          <li key={l.entity}
              className={i === p.emotionalCascade.length - 1
                ? "in-force" : ""}>
            <div className="cascade-head">
              <span className="cascade-entity">
                {registry.entities.get(l.entity)?.label ?? l.entity}
              </span>
              <span className="cascade-name">{nameOf(l.row)}</span>
              {i === p.emotionalCascade.length - 1 && (
                <span className="in-force-tag">in force</span>
              )}
            </div>
            <AuthoredFields entity={l.entity} row={l.row} />
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function ProvenanceView({ p }: { p: Q15Result }): JSX.Element {
  const card = (entity: string) =>
    function Card(r: ProjectedRow, i: number): JSX.Element {
      return (
        <div key={r.uuid ?? i} className="provenance-card">
          <b>{nameOf(r)}</b>
          <AuthoredFields entity={entity} row={r} />
        </div>
      );
    };
  return (
    <div className="qview">
      <h3>Lifecycle</h3>
      {p.row !== null && (
        <dl className="kv-out">
          <div><dt>lifecycle_status</dt>
            <dd>{field(p.row, "lifecycle_status") ?? "—"}</dd></div>
          <div><dt>uuid</dt>
            <dd className="mono">{p.row.uuid ?? "—"}</dd></div>
        </dl>
      )}
      {p.versionChain.length > 1 && (
        <>
          <h3>Version chain</h3>
          <ol className="trail">
            {p.versionChain.map((v, i) => (
              <li key={v.uuid ?? i}>
                {field(v, "version_label") ?? v.uuid ?? "?"}
                {v.uuid === p.row?.uuid && (
                  <span className="in-force-tag">this row</span>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      <h3>Attached decisions</h3>
      {p.attached.decisions.map(card("creative_decision"))}
      {p.attached.decisions.length === 0 && (
        <p className="muted">None attached to this row.</p>
      )}
      <h3>Attached notes</h3>
      {p.attached.notes.map(card("collaboration_note"))}
      {p.attached.notes.length === 0 && (
        <p className="muted">None attached to this row.</p>
      )}
    </div>
  );
}
