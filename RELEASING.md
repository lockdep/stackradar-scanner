# Releasing

The git tag is the single source of truth for the version. There is no version
file to bump and nothing to keep in sync by hand: `Chart.yaml`, `values.yaml`
and `package.json` all hold the placeholder `0.0.0-dev` in the repository, and
the release workflow stamps the real version into them from the tag.

Tagging `v1.2.3` publishes:

| Artifact | Reference |
| --- | --- |
| Image | `ghcr.io/lockdep/stackradar-scanner:1.2.3` (plus `1.2` and `latest`) |
| Chart | `oci://ghcr.io/lockdep/charts/stackradar-scanner:1.2.3` |

with chart `version: 1.2.3` and `appVersion: "1.2.3"`, the image pinned by
digest in the chart's `values.yaml`, both artifacts cosigned, and a GitHub
Release carrying the digests and verification instructions.

## Cutting a release

Run the **Cut release** workflow from the Actions tab and choose `patch`,
`minor` or `major`. From a terminal that is:

```bash
gh workflow run cut-release.yaml -f bump=minor
```

Choosing which of the three it is (see below) is the whole of the decision. The
workflow does the rest:

1. works out the number from the tags that already exist — `v0.1.1` plus a
   `minor` is `0.2.0` — and refuses a version that has been released;
2. moves the `## [Unreleased]` entries in `CHANGELOG.md` under
   `## [0.2.0] - <today>`, updates the compare links at the foot of the file,
   and commits that to `main`;
3. tags that commit `v0.2.0` and starts the release workflow on it.

Nothing needs preparing first. The changelog is written in the pull requests
that change things, under `## [Unreleased]`; cutting a release is what gives
those entries a version. A release whose Unreleased section is empty fails
instead of shipping notes nobody wrote, because that section is read twice —
as the GitHub Release notes and as the chart's `artifacthub.io/changes`
annotation — and is what a user sees when deciding whether to upgrade.

To see the version and the changelog diff without publishing anything:

```bash
gh workflow run cut-release.yaml -f bump=minor -f dry_run=true
```

Then watch the release itself:

```bash
gh run watch "$(gh run list --workflow=release.yaml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

### Tagging by hand

The tag is still the only thing that matters, so releasing without the workflow
is releasing normally — write the `## [1.2.3]` section yourself, land it on
`main`, then:

```bash
git checkout main && git pull
git tag -a v1.2.3 -m "v1.2.3"
git push origin v1.2.3
```

A tag pushed from a laptop starts the release workflow through its `push`
trigger. A tag with no matching changelog section still releases — the notes
fall back to the commit subjects in the tag's range — but the run carries a
warning, because commit subjects are written for us, not for the people running
the chart.

### Choosing the number

Semver, judged from the *user's* perspective — someone who runs
`helm install --version X.Y.Z` and passes their own `values.yaml`:

- **major** — a breaking change to the chart's interface or the agent's contract:
  a renamed or removed key in `values.yaml`, a new required value, a changed
  default that alters behaviour, or an RBAC permission the chart now needs.
- **minor** — new capability that existing installs can take or leave: a new
  optional value, a new template, a scanner feature.
- **patch** — bug fixes and dependency bumps that change nothing a user configures.

While on `0.x`, breaking changes go in the *minor* position (`0.1.0` → `0.2.0`);
semver explicitly allows this pre-1.0.

### Prereleases

A tag with a prerelease suffix (`v1.2.3-rc.1`) publishes the exact version and
nothing else: no `latest`, no rolling `1.2` alias, and the GitHub Release is
marked as a prerelease. Users only get it by asking for it by name, so it is
safe to cut one for testing.

Same workflow, with an identifier — the counter is appended and continues from
whatever candidate exists, so running this twice gives `rc.1` then `rc.2`:

```bash
gh workflow run cut-release.yaml -f bump=minor -f prerelease=rc
```

A candidate does not consume the version and does not touch `CHANGELOG.md`. The
number is always computed from the last *stable* tag, so the `minor` release cut
after `v1.2.0-rc.2` is `1.2.0` itself, and its notes are the entries that were
under `## [Unreleased]` all along. A candidate takes those same notes from a
`## [1.2.0]` section if one exists yet, and otherwise falls back to commit
subjects — a release candidate rehearses a version rather than being one, so
there is no section to add per candidate.

## Released versions are immutable

The release workflow refuses to run if the image tag or the chart version
already exists in GHCR. This is deliberate. A published version is a promise
about specific bytes; republishing over it would invalidate every cosign
signature and digest a user has already recorded, and give two people running
`helm install --version 1.2.3` different software.

If a release is wrong, cut the next patch version. Do not delete and re-push a
tag that has already been released.

If a release run fails *before* it pushed anything — a flaky runner, a GHCR
outage — the tag is fine and only the run needs repeating:

```bash
gh workflow run release.yaml --ref v1.2.3
```

If the tag itself is wrong (cut from the wrong commit, wrong number), delete it
and cut again. The changelog commit it came with stays on `main`, and cutting
the same number a second time reuses the section already written rather than
writing it twice. Only if new entries have landed under `## [Unreleased]` since
does it stop, because merging them into a section that already exists is a
judgement call rather than an edit.

```bash
git push --delete origin v1.2.3
git tag -d v1.2.3
```

If it failed *after* pushing the image but before the chart, the guard will
block the retry — bump to the next patch version instead.

## License notices travel with every artifact

The PolyForm Shield License requires that anyone who receives a copy of the
software also receives the terms. Three copies exist and CI keeps them in sync:

- `LICENSE.md` at the repository root,
- `helm/LICENSE.md`, packaged into every chart `.tgz` (CI fails the build if it
  drifts from the root copy),
- `/app/LICENSE.md` inside the runtime image, plus the
  `org.opencontainers.image.licenses=PolyForm-Shield-1.0.0` label.

If you edit the license, update the root copy and run `cp LICENSE.md helm/LICENSE.md`.

## Verifying a release

Both artifacts use cosign keyless signing, so there is no public key to
distribute. The signature is bound to this repository's release workflow via a
short-lived Sigstore certificate and the Rekor transparency log.

```bash
IDENTITY="^https://github.com/lockdep/stackradar-scanner/.github/workflows/release.yaml@refs/tags/"
ISSUER="https://token.actions.githubusercontent.com"

cosign verify \
  --certificate-identity-regexp "$IDENTITY" \
  --certificate-oidc-issuer "$ISSUER" \
  ghcr.io/lockdep/stackradar-scanner:1.2.3

cosign verify \
  --certificate-identity-regexp "$IDENTITY" \
  --certificate-oidc-issuer "$ISSUER" \
  ghcr.io/lockdep/charts/stackradar-scanner:1.2.3
```

Pin the tag to a digest in the identity regexp if you want to assert *which*
tag produced the artifact, e.g. `...@refs/tags/v1.2.3$`.

The image additionally carries SLSA provenance and an SBOM attestation
generated by BuildKit:

```bash
cosign verify-attestation --type slsaprovenance \
  --certificate-identity-regexp "^https://github.com/lockdep/stackradar-scanner/" \
  --certificate-oidc-issuer "$ISSUER" \
  ghcr.io/lockdep/stackradar-scanner:1.2.3
```

The release workflow runs the two `cosign verify` commands itself before
finishing, so a release that completes has demonstrably verifiable signatures.

## What main publishes

Pushes to `main` publish a moving `main` tag and a `sha-<short>` tag for the
image only — no chart, no semver tag. They are signed the same way, but they
are dogfooding builds: nothing external should depend on them.

The dogfood cluster tracks released chart versions. After a release, bump
`targetRevision` in the gitops repo's `argocd/applications/apps/scanner.yaml`
by hand and let ArgoCD sync it.

## What the docs advertise

The app's "Install the chart" dialog and the landing page's quick-start both
render `--version <SCANNER_CHART_VERSION>` from a ConfigMap, so the install
command users copy is always pinned to a real release. The `advertise` job at
the end of `release.yaml` keeps that in step: after a stable release it
rewrites `SCANNER_CHART_VERSION` in `apps/stack-radar/base/kustomization.yaml`
and `apps/landing-page/base/kustomization.yaml` of both gitops repos — pushed
straight to `lockdep/stackradar-gitops-development`, opened as a PR against
`lockdep/stackradar-gitops`. Merging that PR is the last step of a release;
until then production still advertises the previous version.

Prereleases are never advertised. A rollback is the manual edit the comments
in those files describe, not a re-run of this job.

The job needs `GITOPS_TOKEN` and `GITOPS_PROD_TOKEN` as repository secrets —
the same fine-grained PATs `lockdep/stackradar` uses for image pins.

## Upgrading a deployed scanner

The version the chart reports flows through to the control plane: the
Deployment passes `.Chart.Version` as `STACKRADAR_SCANNER_VERSION`, and the
agent sends it as the `X-Scanner-Version` header on every heartbeat and upload.
Clusters running an outdated chart are therefore visible in the UI, which is
only meaningful now that the version is a real, monotonically increasing semver
rather than a rebuilt `0.1.0`.
