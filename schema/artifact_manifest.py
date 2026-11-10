#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
artifact_manifest.py — record the published artifacts, with checksums,
and the tag each one is addressed by.

The registry, the physical DDL and the fixture need to be fetchable BY
VERSION and verifiable once fetched. The obvious way to do that is to
commit a copy per version, and that is the wrong way: registry.json is
400KB and would be duplicated on every bump, immediately raising the
question of which copy is real.

Git already versions files. What was missing is an addressing scheme and
a way to check that what you downloaded is what was published. So:

  - a tag pins the tree,
  - the raw URL at that tag is the artifact's address,
  - this manifest carries the SHA-256 so a consumer can verify it.

There are two tags, because there are two versions (spec §11.5 and
conventions §8). `schema-X.Y` addresses what cannot change without a
SCHEMA_VERSION bump: the registry and what is generated from it alone.
`spec-X.Y` addresses everything else — the prose, the blessed results,
the fixture — which changes with every specification release, schema
change or not. A schema tag that addressed the prose would have to move
whenever the prose did, and a pin that moves is not a pin.

    python3 schema/artifact_manifest.py            # write
    python3 schema/artifact_manifest.py --check    # verify, for CI

--check fails if any artifact's hash has moved without the manifest
being regenerated, which is the same guarantee the registry generator
gives, applied to publication rather than generation.
"""
import argparse
import hashlib
import pathlib
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from schema_meta import SCHEMA_VERSION  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "spec" / "ARTIFACTS.md"
REPO = "https://raw.githubusercontent.com/MinimalHumans/SCF_studio"


def spec_version() -> str:
    """The version line of spec/scf-spec.md, which §11.5 governs.

    Read from the document rather than declared here: a second copy of
    the version would be a second thing to forget at release time.
    """
    text = (ROOT / "spec" / "scf-spec.md").read_text(encoding="utf-8")
    m = re.search(r"^\*\*Version (\d+\.\d+(?:\.\d+)?(?:-rc\.\d+)?)\b",
                  text, re.M)
    if not m:
        raise SystemExit("spec/scf-spec.md: no '**Version X.Y' line")
    return m.group(1)


SPEC_VERSION = spec_version()

# The tag each pin names. A group's pin is the version whose bump is
# REQUIRED before any of its files may change; anything that can change
# without a schema bump is pinned by the spec.
TAGS = {"schema": f"schema-{SCHEMA_VERSION}", "spec": f"spec-{SPEC_VERSION}"}

# Two lists would drift, so there is one. Everything named here is
# BOTH published in ARTIFACTS.md and checksummed in SHA256SUMS —
# there is no third category of file that is stamped but not
# described, or described but not verifiable.
#
# ARTIFACTS.md and SHA256SUMS are themselves absent, necessarily: a
# file cannot carry its own digest. They are verified by
# regenerating them, which is what --check does and what CI runs.
#
# Each group is (title, pin, note, items); pin is a key of TAGS.
GROUPS: list[tuple[str, str, str, list[tuple[str, str]]]] = [
    ("The specification", "spec",
     "The normative documents, checksummed so that a reader built "
     "against this prose can confirm it read the bytes that were "
     "published.",
     [
        ("spec/scf-spec.md",
         "The specification. Everything normative about the format is "
         "here or cited from here."),
        ("spec/conformance.md",
         "What a conforming implementation must do, per role, and how a "
         "claim is made."),
        ("spec/stability.md",
         "What is safe to build against and what is not, per subject."),
        ("spec/CHANGELOG.md",
         "The specification changelog. Spec §11.5."),
     ]),

    ("Schema and registry", "schema",
     "The registry and what is generated from it, from `schema/`, which "
     "is the source of truth for all of them. None of these can change "
     "without a new schema version.",
     [
        ("scf-core/registry/registry.json",
         "The normative field set. Spec §2.1."),
        ("spec/scf-schema.sql",
         "The physical DDL, dumped from initDatabase(). Spec §1.3."),
        ("spec/screenplay-tables.json",
         "The screenplay infrastructure tables and the `line_type` "
         "vocabulary. Spec §1.3.1."),
        ("spec/entity-reference.md",
         "Every entity and field, generated from the registry. Not "
         "normative — a reading aid over `registry.json`."),
        ("spec/registry.schema.json",
         "JSON Schema for registry.json, so it can be consumed without "
         "running the reference implementation."),
        ("spec/junction-keys.json",
         "Natural keys for every link entity. Spec §6.3."),
        ("spec/scf.magic",
         "magic(5) stanza for file(1). Spec §1.2."),
     ]),

    ("Generated from the specification", "spec",
     "Generated, but from the specification's sections and the "
     "reference implementation rather than from `schema/` alone, so "
     "they can change between specification versions with no schema "
     "change.",
     [
        ("spec/query-reference.md",
         "All sixteen queries in one page, generated from §12, the "
         "published results and `queryPaths.ts`. Not normative."),
        ("spec/api-surface.json",
         "Every name importable from `@minimalhumans/scf-core`, per "
         "entry point, with its kind."),
        ("spec/readiness-rubrics.json",
         "What Q14 assesses, per target query. Spec §12.9.1."),
        ("spec/finding-catalog.json",
         "The normative finding catalog. Spec §9.4 requires every code and "
         "severity to come from here."),
     ]),

    ("The canonical query results", "spec",
     "One normative result per query, spec §12, and a normative result "
     "per case where one position cannot show a member. Rows by uuid, "
     "no row ids, no timestamps.",
     [
        ("fixtures/expectations/Q00.result.json",
         "Q00's normative result. Spec §12.12."),
        ("fixtures/expectations/Q03.result.json",
         "Q03's normative result. Spec §12.4."),
        ("fixtures/expectations/Q01.result.json",
         "Q01's normative result. Spec §12.15."),
        ("fixtures/expectations/Q02.result.json",
         "Q02's normative result. Spec §12.16."),
        ("fixtures/expectations/Q04.result.json",
         "Q04's normative result. Spec §12.17."),
        ("fixtures/expectations/Q05.result.json",
         "Q05's normative result. Spec §12.2."),
        ("fixtures/expectations/Q07.result.json",
         "Q07's normative result. Spec §12.3."),
        ("fixtures/expectations/Q06.result.json",
         "Q06's normative result. Spec §12.6."),
        ("fixtures/expectations/Q08.result.json",
         "Q08's normative result. Spec §12.7."),
        ("fixtures/expectations/Q09.result.json",
         "Q09's normative result. Spec §12.10."),
        ("fixtures/expectations/Q10.result.json",
         "Q10's normative result. Spec §12.11."),
        ("fixtures/expectations/Q11.result.json",
         "Q11's normative result. Spec §12.13."),
        ("fixtures/expectations/Q12.result.json",
         "Q12's normative result. Spec §12.5."),
        ("fixtures/expectations/Q13.result.json",
         "Q13's normative result. Spec §12.8."),
        ("fixtures/expectations/Q14.result.json",
         "Q14's normative result. Spec §12.9."),
        ("fixtures/expectations/Q15.result.json",
         "Q15's normative result. Spec §12.14."),
        ("fixtures/expectations/Q02-marcus-scene25.result.json",
         "Q02 for a character in a variant (§4.8). Spec §12.16."),
        ("fixtures/expectations/Q02-locket-scene25.result.json",
         "Q02 for a prop: its variant and state. Spec §12.16."),
        ("fixtures/expectations/Q02-kitchen-scene10.result.json",
         "Q02 for a location: §12.17's ranked axes. Spec §12.16."),
        ("fixtures/expectations/Q02-church-scene16.result.json",
         "Q02 for a location: `varies` agrees on time. Spec §12.16."),
        ("fixtures/expectations/Q02-ridge-scene21.result.json",
         "Q02 for a location: nothing agrees, so the baseline. Spec §12.16."),
        ("fixtures/expectations/Q03-scene25.result.json",
         "Q03 where variants are in force. Spec §12.4."),
        ("fixtures/expectations/Q04-scene25.result.json",
         "Q04 where variants are in force. Spec §12.17."),
        ("fixtures/expectations/Q05-scene19.result.json",
         "Q05 where a vocal state is in force. Spec §12.2."),
        ("fixtures/expectations/Q07-shot12A.result.json",
         "Q07 at a shot with no row of its own: the scene's applies (§7.3). "
         "Spec §12.3."),
        ("fixtures/expectations/Q12-scene24-25.result.json",
         "Q12 into a variant. Spec §12.5."),
        ("fixtures/expectations/Q12-scene25-24.result.json",
         "Q12 out of a variant. Spec §12.5."),
        ("fixtures/expectations/Q13-scene3.result.json",
         "Q13 where a filtered binding is excluded. Spec §12.8."),
        ("fixtures/expectations/Q13-scene25.result.json",
         "Q13 where a variant replaces the baseline. Spec §12.8."),
        ("fixtures/expectations/Q15-plate-v2.result.json",
         "Q15 on a versioned row: its chain (§6.1). Spec §12.14."),
        ("fixtures/expectations/Q07-scene3.result.json",
         "Q07 where two latest_wins rows tie: the higher row id (§4.5). "
         "Spec §12.3."),
        ("fixtures/expectations/Q04-scene21.result.json",
         "Q04 where staging beats sit in an action sequence. Spec §12.17."),
        ("fixtures/expectations/Q14-Q02-locket-scene25.result.json",
         "Q14 for Q02 about a prop. Spec §12.9."),
        ("fixtures/expectations/Q14-Q13-eleanor-shot1204.result.json",
         "Q14 for Q13, every step reported. Spec §12.9."),
        ("fixtures/expectations/Q13-shot1204.result.json",
         "Q13 asked with a shot and no scene: the shot's scene is the "
         "position. Spec §12.1.7."),
        ("fixtures/expectations/Q14-Q02-eleanor-scene7.result.json",
         "Q14 for Q02 about a character: a relationship state one "
         "reference away, a costume owned and not worn. Spec §12.9.1."),
        ("fixtures/expectations/Q14-Q07-shot12A.result.json",
         "Q14 for Q07 at a shot that falls through to the scene's "
         "lighting. Spec §12.9.1."),
        ("fixtures/expectations/Q14-Q13-shawl-scene12.result.json",
         "Q14 for Q13 about a costume: steps that do not apply. Spec "
         "§12.9.1."),
        ("fixtures/expectations/Q14-Q02-kitchen-scene10.result.json",
         "Q14 for Q02 about a location: the media step asks for "
         "`environment`. Spec §12.9.1."),
        ("fixtures/expectations/Q14-Q13-windchime-scene12.result.json",
         "Q14 for Q13 where the subject's binding is excluded at the "
         "position: a blocker. Spec §12.9.1."),
        ("fixtures/expectations/Q14-Q02-ada-scene3.result.json",
         "Q14 for Q02 about a character only mentioned: the look steps "
         "do not apply. Spec §12.9."),
        ("fixtures/expectations/Q14-Q13-marcus-scene12.result.json",
         "Q14 for Q13 where the subject's only verified anchor is a "
         "variant's, not in force at the position: a warning. Spec "
         "§12.9.1."),
     ]),

    ("The canonical query parameters", "spec",
     "What each published result was asked, as selectors that resolve "
     "against the fixture by content rather than by row id.",
     [
        ("fixtures/expectations/selectors.json",
         "The selectors, and the parameters of every published result. "
         "Conformance §5.4."),
     ]),

    ("The negative fixtures", "spec",
     "Minimal files that are wrong in a stated way, and the report "
     "each MUST produce. Stamped since 0.31: conformance turns on "
     "reproducing these reports exactly, so their bytes matter as "
     "much as any generated artifact's.",
     [
        ("fixtures/negative/CASES.json",
         "Every negative fixture as a reproducible recipe. Spec "
         "conformance.md §5.3."),
        ("fixtures/negative/asset-absolute.expected.json",
         "An absolute asset identifier: permitted, non-portable, a warning. Spec conformance.md §5.3."),
        ("fixtures/negative/asset-orphans-two.expected.json",
         "Two orphans, one finding with count 2 (§9.5's grain). Spec conformance.md §5.3."),
        ("fixtures/negative/asset-escapes-root.expected.json",
         "An asset address that resolves outside the root. Spec conformance.md §5.3."),
        ("fixtures/negative/bundle-unbound.expected.json",
         "A bundle no binding reaches. Spec conformance.md §5.3."),
        ("fixtures/negative/header-unstamped.expected.json",
         "A file carrying no SCF application id. Spec conformance.md §5.3."),
        ("fixtures/negative/junction-endpoint-absent.expected.json",
         "A link with a missing end. Spec conformance.md §5.3."),
        ("fixtures/negative/line-type-unknown.expected.json",
         "A screenplay line whose type is outside the closed set. Spec conformance.md §5.3."),
        ("fixtures/negative/relationship-contradictory.expected.json",
         "Two relationship rows that disagree. Spec conformance.md §5.3."),
        ("fixtures/negative/relationship-directionality-absent.expected.json",
         "A directional relationship with no direction. Spec conformance.md §5.3."),
        ("fixtures/negative/relationship-endpoint-absent.expected.json",
         "A relationship pointing at a row that is not there. Spec conformance.md §5.3."),
        ("fixtures/negative/section-mismatch.expected.json",
         "A section line bound to an act renamed since. Spec conformance.md §5.3."),
        ("fixtures/negative/span-boundary-dangling.expected.json",
         "An act anchored to a scene that is not present. Spec conformance.md §5.3."),
        ("fixtures/negative/span-boundary-cut.expected.json",
         "An act whose start scene is cut: it covers no scene (§5.5). Spec conformance.md §5.3."),
        ("fixtures/negative/junction-key-null.expected.json",
         "Two links whose null key columns compare equal (§6.4). Spec conformance.md §5.3."),
        ("fixtures/negative/reference-dangling.expected.json",
         "Three references that are filled and name no row (§9.1). Spec conformance.md §5.3."),
        ("fixtures/negative/unknown-table.expected.json",
         "A table the registry does not declare. Spec conformance.md §5.3."),
        ("fixtures/negative/uuid-duplicate.expected.json",
         "One uuid on more than one row. Spec conformance.md §5.3."),
        ("fixtures/negative/uuid-malformed.expected.json",
         "A uuid that is not a uuid. Spec conformance.md §5.3."),
        ("fixtures/negative/uuid-missing.expected.json",
         "A row carrying no uuid at all. Spec conformance.md §5.3."),
     ]),

    ("The fixture", "spec",
     "",
     [
        ("fixtures/hollow_creek.scf",
         "The conformance fixture. Its load-bearing properties are "
         "enumerated in spec/conformance.md §5.1."),
        ("fixtures/hollow_creek.report.json",
         "The report a validator MUST produce for the fixture. Spec "
         "conformance.md §6.1."),
     ]),
]

ARTIFACTS = [item for _, _, _, items in GROUPS for item in items]

# Every published path, mapped to the tag that addresses it. check_pin.py
# verifies each file against this tag, and fails on a path with none.
PINS = {rel: TAGS.get(pin) for _, pin, _, items in GROUPS for rel, _ in items}

# Families a conformance claim is graded against file by file, so the
# list must hold every member. A blessed report left off it is published
# without a digest, and --check cannot notice: it compares the manifest
# with the list, and the list is what is missing the file.
COVERED = ["fixtures/negative/*.expected.json",
           "fixtures/expectations/Q[0-9][0-9]*.result.json"]


def unlisted() -> list[str]:
    listed = {rel for rel, _ in ARTIFACTS}
    return sorted(rel for pattern in COVERED for p in ROOT.glob(pattern)
                  if (rel := p.relative_to(ROOT).as_posix()) not in listed)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def render() -> str:
    schema_tag, spec_tag = TAGS["schema"], TAGS["spec"]
    counts = {tag: sum(1 for t in PINS.values() if t == tag)
              for tag in TAGS.values()}
    lines = [
        # Generated prose, so the header is emitted here rather than by
        # tools/add_spdx_headers.py — which skips this file for exactly
        # that reason. CC BY 4.0, not Apache-2.0: see spec/LICENSE.
        "<!-- SPDX-License-Identifier: CC-BY-4.0 -->",
        "",
        "# Published artifacts",
        "",
        "GENERATED by `schema/artifact_manifest.py`. Do not hand-edit.",
        "",
        f"Specification **{SPEC_VERSION}**, tag `{spec_tag}`. "
        f"Schema version **{SCHEMA_VERSION}**, tag `{schema_tag}`.",
        "",
        "## Addressing",
        "",
        "A tag pins the tree; the raw URL at that tag is the artifact's",
        "address. Nothing is duplicated per version — git already stores",
        "the history, and a second copy in the working tree would only",
        "raise the question of which one is real.",
        "",
        "There are two tags, because there are two versions. Each group",
        "below names the tag that addresses it:",
        "",
        f"- **`{schema_tag}`** ({counts[schema_tag]} files) — the registry",
        "  and what is generated from it alone. None of them can change",
        "  without a new schema version, so this tag never moves.",
        f"- **`{spec_tag}`** ({counts[spec_tag]} files) — everything else:",
        "  the specification documents, the blessed results and reports,",
        "  and the fixture. These change with every specification release,",
        "  including candidates that change no schema.",
        "",
        "```",
        f"{REPO}/{schema_tag}/<path>",
        f"{REPO}/{spec_tag}/<path>",
        "```",
        "",
        "So the registry for this version is:",
        "",
        "```",
        f"{REPO}/{schema_tag}/scf-core/registry/registry.json",
        "```",
        "",
        "and the specification is:",
        "",
        "```",
        f"{REPO}/{spec_tag}/spec/scf-spec.md",
        "```",
        "",
        "Every file is also present, unchanged, at the spec tag: a",
        "specification release carries the schema it describes. The",
        "schema tag is the address that stays put across specification",
        "releases.",
        "",
        "`main` is a moving target and MUST NOT be used to pin a version.",
        "",
        "## Verification",
        "",
        "In a checkout of the spec tag:",
        "",
        "```sh",
        "sha256sum -c spec/SHA256SUMS",
        "```",
        "",
        f"## Artifacts ({len(ARTIFACTS)})",
        "",
        "This list is exhaustive in both directions: everything below is",
        "published here AND checksummed in `SHA256SUMS`, and nothing is",
        "checksummed that is not described here.",
        "",
        "`ARTIFACTS.md` and `SHA256SUMS` are necessarily absent — a file",
        "cannot carry its own digest. They are verified by regenerating",
        "them, which is what CI does on every run, and are fetched from",
        f"`{spec_tag}`.",
        "",
    ]
    sums = []
    for group, pin, note, items in GROUPS:
        if pin not in TAGS:
            raise SystemExit(f"group {group!r}: pin {pin!r} is not one of "
                             f"{sorted(TAGS)}")
        lines += [f"### {group}", "", f"Tag: `{TAGS[pin]}`.", ""]
        if note:
            lines += [note, ""]
        lines += ["| Artifact | SHA-256 | What it is |", "|---|---|---|"]
        for rel, desc in items:
            path = ROOT / rel
            if not path.exists():
                raise SystemExit(f"missing artifact: {rel}")
            digest = sha256(path)
            sums.append(f"{digest}  {rel}")
            lines.append(f"| `{rel}` | `{digest[:16]}…` | {desc} |")
        lines.append("")
    lines += [
        "Full digests are in [`SHA256SUMS`](SHA256SUMS).",
        "",
        "## Releasing",
        "",
        "Steps 6 and 7 of the change procedure in `docs/conventions.md` §8.",
        "Every release creates NEW tags; none moves one.",
        "",
        "A specification release — every candidate included — tags the",
        "spec:",
        "",
        "```sh",
        "python3 schema/artifact_manifest.py",
        f"git tag -a {spec_tag} -m 'spec {SPEC_VERSION}'",
        f"git push origin {spec_tag}",
        "```",
        "",
        "A release that also bumps `SCHEMA_VERSION` tags the schema on the",
        "same commit:",
        "",
        "```sh",
        f"git tag -a {schema_tag} -m 'schema {SCHEMA_VERSION}'",
        f"git push origin {schema_tag}",
        "```",
        "",
        "A schema version is only ever released inside a specification",
        "release (conventions §8 step 5a), so a schema tag always has a",
        "spec tag beside it. A specification release with no schema",
        "change leaves the existing schema tag where it is.",
        "",
        "Then `python3 schema/check_pin.py --strict`, which verifies",
        "every file above against its own tag and fails if any file is",
        "unpinned. The tags are what make the URLs above resolve; until",
        "they exist, this manifest describes addresses that 404.",
        "",
        "An **annotated** tag, not a signed one. A signed tag would add",
        "provenance — proof the tag came from whoever holds the key —",
        "and that matters once third parties fetch artifacts by tag and",
        "not before. `git tag -s` is a drop-in substitute wherever a",
        "signing key is configured, and nothing else here changes.",
        "",
        "Digests are over RAW BYTES. A checkout whose working tree has",
        "CRLF line endings will not match; `.gitattributes` sets",
        "`eol=lf` to prevent that.",
        "",
    ]
    return "\n".join(lines), "\n".join(sums) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="verify without writing; non-zero if stale")
    args = ap.parse_args()

    missing = unlisted()
    if missing:
        print("[artifacts] published and not in the manifest — add each "
              "to GROUPS:\n  " + "\n  ".join(missing), file=sys.stderr)
        return 1

    manifest, sums = render()
    sums_path = ROOT / "spec" / "SHA256SUMS"

    if args.check:
        stale = []
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != manifest:
            stale.append(str(OUT.relative_to(ROOT)))
        if (not sums_path.exists()
                or sums_path.read_text(encoding="utf-8") != sums):
            stale.append(str(sums_path.relative_to(ROOT)))
        if stale:
            print("[artifacts] STALE: " + ", ".join(stale))
            # TEXT artifacts only. `hollow_creek.scf` is a SQLite
            # database and contains \r\n byte pairs by coincidence, so
            # including it made this branch fire on any staleness at all
            # and advise renormalising a binary file. A NUL in the first
            # few KB is the same binary test git itself uses.
            def is_text(path: pathlib.Path) -> bool:
                return b"\x00" not in path.read_bytes()[:8000]

            crlf = [rel for rel, _ in ARTIFACTS
                    if is_text(ROOT / rel)
                    and b"\r\n" in (ROOT / rel).read_bytes()]
            if crlf:
                # Almost always the real cause on Windows, and the
                # message above sends you to the one command that makes
                # it worse: regenerating writes CRLF-derived digests
                # that then fail on the Linux runner.
                print()
                print(f"  {len(crlf)} artifact(s) have CRLF line endings, "
                      "including:")
                for rel in crlf[:3]:
                    print(f"    {rel}")
                print()
                print("  These digests are over RAW BYTES, so a CRLF "
                      "working tree cannot match")
                print("  a manifest blessed on LF. DO NOT REGENERATE — "
                      "fix the checkout:")
                print()
                print("    git add --renormalize .")
                print("    git checkout-index -a -f")
                print()
                print("  .gitattributes sets `eol=lf` to prevent this. "
                      "A checkout made")
                print("  before that line existed still has CRLF until "
                      "it is renormalised.")
                return 1
            print("  run: python3 schema/artifact_manifest.py")
            return 1
        print(f"[artifacts] up to date ({len(ARTIFACTS)} artifacts, "
              f"spec {SPEC_VERSION}, schema {SCHEMA_VERSION}).")
        return 0

    # newline="\n" on purpose: in text mode Python on Windows writes CRLF,
    # and SHA256SUMS is over raw bytes (see .gitattributes). Without it a
    # Windows run published digests of files that exist nowhere.
    OUT.write_text(manifest, encoding="utf-8", newline="\n")
    sums_path.write_text(sums, encoding="utf-8", newline="\n")
    print(f"[artifacts] wrote {len(ARTIFACTS)} artifacts, "
          f"spec {SPEC_VERSION}, schema {SCHEMA_VERSION}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
