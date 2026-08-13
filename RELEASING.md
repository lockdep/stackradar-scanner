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

First the changelog. Move the `## [Unreleased]` entries in `CHANGELOG.md` under
a heading for the version you are about to tag, date it, and land that commit on
`main`:

```markdown
## [1.2.3] - 2026-08-13
```

The release workflow reads exactly that section and uses it twice: as the
GitHub Release notes, and as the chart's `artifacthub.io/changes` annotation.
It is what a user sees on the releases page and on ArtifactHub when deciding
whether to upgrade, so write it for them.

A tag with no matching section still releases — the notes fall back to the
commit subjects in the tag's range — but the run carries a warning, because
commit subjects are written for us, not for the people running the chart.

Then tag:

```bash
git checkout main && git pull
git tag -a v1.2.3 -m "v1.2.3"
git push origin v1.2.3
```

That is the rest of it. Watch the run:

```bash
gh run watch "$(gh run list --workflow=release.yaml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

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

Its notes come from the `## [1.2.3]` section — a release candidate rehearses a
version, so it ships the notes that version will ship with. There is no need to
add a section per candidate.

## Released versions are immutable

The release workflow refuses to run if the image tag or the chart version
already exists in GHCR. This is deliberate. A published version is a promise
about specific bytes; republishing over it would invalidate every cosign
signature and digest a user has already recorded, and give two people running
`helm install --version 1.2.3` different software.

If a release is wrong, cut the next patch version. Do not delete and re-push a
tag that has already been released.

If a release run fails *before* it pushed anything, delete the tag and re-push
it:

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

## Upgrading a deployed scanner

The version the chart reports flows through to the control plane: the
Deployment passes `.Chart.Version` as `STACKRADAR_SCANNER_VERSION`, and the
agent sends it as the `X-Scanner-Version` header on every heartbeat and upload.
Clusters running an outdated chart are therefore visible in the UI, which is
only meaningful now that the version is a real, monotonically increasing semver
rather than a rebuilt `0.1.0`.
