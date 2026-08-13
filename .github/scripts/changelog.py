#!/usr/bin/env python3
"""Extract one version's section from CHANGELOG.md.

The release workflow calls this with the version it is building and uses the
output in two places:

  --notes    the section's markdown, prepended to the GitHub Release notes.
  --changes  the same entries as `artifacthub.io/changes` YAML, stamped into
             Chart.yaml so ArtifactHub shows the release's changelog.

Exit status is 3 when the changelog has no section for this version. That is a
soft failure by design: the workflow falls back to commit subjects and warns,
rather than blocking a release on a file nobody remembered to edit.

Run it locally the same way CI does:

    python3 .github/scripts/changelog.py 0.1.0 --notes /dev/stdout
"""

from __future__ import annotations

import argparse
import json
import re
import sys

# ArtifactHub accepts exactly these kinds. A `###` heading that is not one of
# them is not a typo we should guess at, so its entries fall back to `changed`.
KINDS = {"added", "changed", "deprecated", "removed", "fixed", "security"}
DEFAULT_KIND = "changed"

# `## [1.2.3] - 2026-08-13`, `## 1.2.3`, and everything in between.
VERSION_HEADING = re.compile(r"^##\s+\[?(?P<version>[^\]\s]+)\]?\s*(?:-.*)?$")
SECTION_HEADING = re.compile(r"^###\s+(?P<kind>.+?)\s*$")
BULLET = re.compile(r"^\s*[-*]\s+(?P<text>.*)$")


def sections(lines: list[str]) -> list[tuple[str, int, list[str]]]:
    """(version, 1-based heading line, body lines) for every `## <version>`."""
    found: list[tuple[str, int, list[str]]] = []
    for number, line in enumerate(lines, start=1):
        match = VERSION_HEADING.match(line)
        if match:
            found.append((match.group("version"), number, []))
        elif found:
            found[-1][2].append(line)
    return found


def section_for(lines: list[str], version: str) -> list[str] | None:
    """The body lines under `## <version>`, exclusive of the heading."""
    for name, _, body in sections(lines):
        if name == version:
            return body
    return None


def problems(lines: list[str], path: str) -> list[str]:
    """Everything wrong with the file, as `path:line: message` strings."""
    found: list[str] = []
    parsed = sections(lines)

    if not any(name.lower() == "unreleased" for name, _, _ in parsed):
        found.append(f"{path}:1: no '## [Unreleased]' section to add entries to")

    for name, number, body in parsed:
        for offset, line in enumerate(body, start=number + 1):
            heading = SECTION_HEADING.match(line)
            if heading and heading.group("kind").strip().lower() not in KINDS:
                found.append(
                    f"{path}:{offset}: '{heading.group('kind').strip()}' is not an "
                    f"ArtifactHub change kind; its entries would be published as "
                    f"'{DEFAULT_KIND}'. Use one of: "
                    + ", ".join(sorted(KINDS))
                )
        if name.lower() != "unreleased" and not entries(body):
            found.append(
                f"{path}:{number}: section '{name}' has no entries, so releasing "
                f"it would fall back to commit subjects"
            )

    return found


def entries(body: list[str]) -> list[tuple[str, str]]:
    """(kind, description) pairs, one per bullet, wrapped lines joined."""
    found: list[tuple[str, str]] = []
    kind = DEFAULT_KIND
    current: list[str] | None = None

    def flush() -> None:
        nonlocal current
        if current:
            text = re.sub(r"\s+", " ", " ".join(current)).strip()
            # `**breaking**` reads as literal asterisks wherever ArtifactHub
            # renders the annotation as plain text.
            text = text.replace("**", "")
            if text:
                found.append((kind, text))
        current = None

    for line in body:
        heading = SECTION_HEADING.match(line)
        if heading:
            flush()
            name = heading.group("kind").strip().lower()
            kind = name if name in KINDS else DEFAULT_KIND
            continue

        bullet = BULLET.match(line)
        if bullet:
            flush()
            current = [bullet.group("text")]
        elif current is not None and line.strip():
            current.append(line.strip())  # continuation of a wrapped bullet
        else:
            flush()

    flush()
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "version", nargs="?", help="version to extract, without a leading v"
    )
    parser.add_argument("--file", default="CHANGELOG.md")
    parser.add_argument("--notes", help="write the section's markdown here")
    parser.add_argument("--changes", help="write artifacthub.io/changes YAML here")
    parser.add_argument(
        "--check",
        action="store_true",
        help="validate the whole file instead of extracting one version",
    )
    args = parser.parse_args()

    with open(args.file, encoding="utf-8") as fh:
        lines = fh.read().splitlines()

    if args.check:
        found = problems(lines, args.file)
        for problem in found:
            print(problem, file=sys.stderr)
        if found:
            return 1
        print(f"{args.file} is well formed", file=sys.stderr)
        return 0

    if not args.version:
        parser.error("a version is required unless --check is given")

    body = section_for(lines, args.version)
    if body is None:
        print(f"No '## {args.version}' section in {args.file}", file=sys.stderr)
        return 3

    found = entries(body)
    if not found:
        print(f"Section '## {args.version}' in {args.file} has no entries", file=sys.stderr)
        return 3

    if args.notes:
        with open(args.notes, "w", encoding="utf-8") as fh:
            fh.write("\n".join(body).strip() + "\n")

    if args.changes:
        # json.dumps gives a quoted scalar that is valid YAML, so a description
        # containing ':' or '#' cannot break the annotation.
        with open(args.changes, "w", encoding="utf-8") as fh:
            fh.write(
                "\n".join(
                    f"- kind: {kind}\n  description: {json.dumps(text, ensure_ascii=False)}"
                    for kind, text in found
                )
                + "\n"
            )

    print(f"{len(found)} changelog entries for {args.version}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
