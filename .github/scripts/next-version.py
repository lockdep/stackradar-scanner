#!/usr/bin/env python3
"""Work out the next release version from the tags that already exist.

The git tag is the source of truth for the version (see RELEASING.md), so the
only thing a release needs decided is *which part of it moves*. This turns that
decision into a version number:

    patch   0.1.1 -> 0.1.2
    minor   0.1.1 -> 0.2.0
    major   0.1.1 -> 1.0.0

The base is always the highest *stable* tag. A prerelease never becomes the base
for the next release, so cutting `v0.2.0-rc.1` and then a `minor` release still
gives `0.2.0` rather than skipping to `0.3.0`.

With `--prerelease rc` the same bump produces a release candidate for that
version, counting up from any candidate already cut for it:

    (no rc yet)   minor --prerelease rc -> 0.2.0-rc.1
    0.2.0-rc.1    minor --prerelease rc -> 0.2.0-rc.2

Output is written as `key=value` lines for $GITHUB_OUTPUT:

    version=0.2.0
    previous=v0.1.1

Run it locally the same way CI does:

    python3 .github/scripts/next-version.py minor
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys

# Semver, minus build metadata — release.yaml rejects '+' because it is not a
# legal character in an OCI reference, so there is no point producing one here.
TAG = re.compile(
    r"^v(?P<major>0|[1-9]\d*)\.(?P<minor>0|[1-9]\d*)\.(?P<patch>0|[1-9]\d*)"
    r"(?:-(?P<pre>[0-9A-Za-z.-]+))?$"
)


def identifiers(pre: str) -> list[tuple[int, int, str]]:
    """Sort key for a prerelease string, by semver precedence rules.

    Numeric identifiers compare numerically and rank below alphanumeric ones,
    so `rc.2` sorts after `rc.10`'s sibling `rc.9` rather than as text.
    """
    key: list[tuple[int, int, str]] = []
    for part in pre.split("."):
        if part.isdigit():
            key.append((0, int(part), ""))
        else:
            key.append((1, 0, part))
    return key


def precedence(tag: tuple[int, int, int, str]) -> tuple:
    """Full ordering key: a prerelease ranks below the version it precedes."""
    major, minor, patch, pre = tag
    return (major, minor, patch, 0 if pre else 1, identifiers(pre) if pre else [])


def tags() -> list[tuple[int, int, int, str]]:
    """Every `v<semver>` tag in the repository, as parsed tuples."""
    listed = subprocess.run(
        ["git", "tag", "--list", "v*"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()

    found = []
    for name in listed:
        match = TAG.match(name)
        if match:
            found.append(
                (
                    int(match.group("major")),
                    int(match.group("minor")),
                    int(match.group("patch")),
                    match.group("pre") or "",
                )
            )
    return found


def render(tag: tuple[int, int, int, str]) -> str:
    major, minor, patch, pre = tag
    return f"{major}.{minor}.{patch}" + (f"-{pre}" if pre else "")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bump", choices=("patch", "minor", "major"))
    parser.add_argument(
        "--prerelease",
        default="",
        metavar="ID",
        help="cut a release candidate instead, e.g. 'rc' for 0.2.0-rc.1",
    )
    args = parser.parse_args()

    identifier = args.prerelease.strip()
    if identifier and not re.fullmatch(r"[0-9A-Za-z-]+", identifier):
        parser.error(
            f"prerelease identifier '{identifier}' is not alphanumeric; "
            f"the counter is appended, so pass 'rc', not 'rc.1'"
        )

    existing = tags()
    stable = [tag for tag in existing if not tag[3]]
    # No stable tag yet means the first release is a bump from 0.0.0, so
    # `patch` gives 0.0.1 and `minor` gives 0.1.0.
    base = max(stable, key=precedence) if stable else (0, 0, 0, "")

    major, minor, patch, _ = base
    if args.bump == "major":
        core = (major + 1, 0, 0)
    elif args.bump == "minor":
        core = (major, minor + 1, 0)
    else:
        core = (major, minor, patch + 1)

    if identifier:
        # Continue the sequence for this exact version, so a second candidate
        # for 0.2.0 is rc.2 and not another rc.1.
        counter = 0
        for tag in existing:
            if tag[:3] != core or not tag[3]:
                continue
            parts = tag[3].split(".")
            if parts[0] == identifier and len(parts) == 2 and parts[1].isdigit():
                counter = max(counter, int(parts[1]))
        version = (*core, f"{identifier}.{counter + 1}")
    else:
        version = (*core, "")

    if version in existing:
        print(
            f"v{render(version)} already exists. Released versions are immutable "
            f"— cut the next one instead (see RELEASING.md).",
            file=sys.stderr,
        )
        return 1

    # The previous tag is what the changelog's compare link points at, and what
    # the release notes are diffed against. It is the highest tag overall, not
    # the highest stable one: the candidates cut for this version came after it.
    previous = max(existing, key=precedence) if existing else None

    print(f"version={render(version)}")
    print(f"previous={'v' + render(previous) if previous else ''}")

    print(
        f"{'v' + render(previous) if previous else '(no tags yet)'}"
        f" -> v{render(version)} ({args.bump})",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
