---
name: changelog
description: Use whenever changing the stackradar-scanner agent or its Helm chart — code in src/, templates or values in helm/, the Dockerfile, RBAC, or agent behavior. Every user-visible change needs a CHANGELOG.md entry under ## [Unreleased] in the same commit, and never inside an already-released version section. Load BEFORE committing scanner changes.
---

# Scanner changelog discipline

The release pipeline reads `CHANGELOG.md` twice: the `## [Unreleased]` section
becomes the GitHub Release notes and the chart's `artifacthub.io/changes`
annotation. A release cut with an empty Unreleased section **fails the
cut-release workflow**. An entry filed under the wrong section ships wrong
release notes or none at all.

## The one rule that has been broken twice

New entries go under `## [Unreleased]` — the section at the top with no date.
**Never add an entry to a `## [X.Y.Z] - <date>` section.** Those versions are
already tagged and published; their notes are immutable, and an entry placed
there describes unshipped code under a shipped version while leaving Unreleased
empty, which breaks the next release cut. This exact mistake caused commits
b6ff6f1 and the failed 0.1.9 cut on 2026-08-18. If you find an entry for
unreleased code sitting in a dated section, move it verbatim up to Unreleased.

## When an entry is required

Any change a chart user could observe: agent behavior, report payloads, new or
changed `values.yaml` keys, defaults, RBAC rules, probes, log messages they
might act on, bug fixes, security-relevant build changes.

No entry for: pure refactors, tests, CI/workflow changes, docs, comments —
anything invisible to someone running `helm install` with their own values.
When in doubt, write one.

## Writing the entry

1. Place it under `## [Unreleased]`, grouped by one of exactly six `###`
   headings — `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`
   (they map to ArtifactHub change kinds; no other heading is valid). Create
   the heading under Unreleased if it doesn't exist yet.
2. Write for the person who runs `helm install --version X.Y.Z` and passes
   their own values — not for us. Lead with a **bold sentence stating what
   they observe or gain**, then explain the why and the mechanism. Read the
   existing 0.1.x entries first and match their voice and depth.
3. Always state, when applicable:
   - **RBAC changes** — which verbs on which resources, and the value that
     removes the rule ("New RBAC: … `--set scanner.X=false` removes the rule",
     or "No new RBAC").
   - **Upgrade impact** — "Nothing to configure", "nothing changes for
     existing installs" when defaults render nothing, or exactly what breaks
     and how to check (`helm template` etc.).
   - **Control-plane requirements** — payload version bumps, fallback behavior
     against an older server.
   - What the change deliberately does *not* do, when a reader would
     reasonably assume otherwise.
4. Do **not** touch version numbers, dates, or the compare links at the foot
   of the file, and do not create a new `## [X.Y.Z]` section — the cut-release
   workflow promotes Unreleased and rewrites the links itself. (Hand-written
   sections happen only in the manual-tagging flow in RELEASING.md.)
5. The entry ships in the same commit/PR as the code change.

## Verify before committing

```bash
python3 .github/scripts/changelog.py --check
```

This validates the file's structure (it cannot catch an entry filed under a
released version — rule one above is on you). Also confirm with `git diff
CHANGELOG.md` that every added line sits above the newest `## [X.Y.Z]`
heading.

Versioning, prereleases, and cutting the release itself: see
[RELEASING.md](../../../RELEASING.md).
