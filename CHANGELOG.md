# Changelog

Notable changes to the agent and its Helm chart, written from the perspective of
someone who runs `helm install --version X.Y.Z` and passes their own values.

One number covers both: the chart version, the image tag and `appVersion` are
always the same, cut from a `v*` git tag. See [RELEASING.md](RELEASING.md).

The release workflow reads the section matching the tag it is building and uses
it for the GitHub Release notes and the chart's `artifacthub.io/changes`
annotation. What is written here is what users read on ArtifactHub, so it is
worth wording for them rather than for us. A release with no section here falls
back to the commit subjects in the tag's range, and warns.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The `###`
headings map to ArtifactHub's change kinds — Added, Changed, Deprecated,
Removed, Fixed, Security — so use those six and nothing else.

## [Unreleased]

## [0.4.0] - 2026-09-17

### Added

- **The agent now sends image metadata beside each SBOM — this widens what
  leaves your cluster.** For every image it scans, the upload carries the
  image's ordered layer list with the Dockerfile line that made each layer,
  and a fixed set of facts from the image config and manifest: the OCI
  base-image, source and version annotations, architecture and OS, the image's
  default user, the executable it starts, and `ENV` keys ending `_VERSION`.
  StackRadar uses it to separate the findings your own build added from the
  base image's, and to recommend a newer base. What is sent is a literal,
  snapshot-tested list — every property is named under "What leaves your
  cluster" in the README — and three things never are: Dockerfile lines are
  redacted in the agent first (recorded build args dropped, secret-named
  values, `Bearer`/`Basic` credentials and URL userinfo masked, 200-character
  cap); `CMD` / `ENTRYPOINT` are sent as `argv[0]` only, never their
  arguments (a `CMD` that *is* the entrypoint's arguments — it starts with
  `-` or carries a `=` — is not sent at all); and no other environment variable leaves. **Opt out with
  `scanner.imageMetadata=false`**: the upload is then syft's CycloneDX
  document and nothing else, and everything except base-image attribution
  works as before.

### Changed

- **syft now runs with `--scope deep-squashed`.** The package set is the same
  as before — what is in the image's final filesystem — but each package now
  records every layer it existed in rather than only the layer of the package
  database, which for apk and rpm images was always the last layer to run the
  package manager. No new findings, no new data leaving the cluster; SBOMs are
  about 1 % larger. Images already scanned pick it up on their next scan.

- **Stable 0.x releases are no longer marked "Pre-release" on Artifact Hub.**
  The chart used to carry `artifacthub.io/prerelease: "true"` on every version
  below 1.0.0, so all releases showed the badge even though they are the
  supported line. The annotation is now set only on release candidates
  (`vX.Y.Z-rc.N`); stable tags ship without it. Nothing to configure, and
  nothing changes for existing installs — this is chart metadata only, and
  versions already published keep the badge they were released with.

## [0.3.0] - 2026-08-25

### Added

- **Scan failures are now reported with a reason.** When syft cannot pull an
  image, the agent classifies the failure — registry authentication
  (401/403/denied), registry rate limiting (429/TOOMANYREQUESTS), or a generic
  scan error — and reports the code and registry host on its 5-minute
  inventory cycle, so the StackRadar coverage card can say *why* an image has
  no SBOM instead of "generating SBOMs" forever. Only the code and the host
  leave the cluster, never syft's output; retry behaviour is unchanged, and a
  successful upload clears the reported failure. Works against a StackRadar
  control plane that predates the field too — older servers ignore it.

### Fixed

- syft's filesystem cache now lives under the `/tmp` scratch volume
  (`SYFT_CACHE_DIR`, overridable). It previously defaulted to `/.cache/syft`,
  which `readOnlyRootFilesystem` makes unwritable, so every scan logged
  `WARN unable to get filesystem cache` before doing anything.

## [0.2.0] - 2026-08-23

### Added

- **Initial public release** of the StackRadar scanner and its Helm chart.
  The scanner runs in your cluster, builds an SBOM of every running image,
  discovers Helm releases and the Kubernetes version, and reports them to
  StackRadar so you can see what you run, what is vulnerable, and what to
  upgrade. Install with `helm install` from
  `oci://ghcr.io/lockdep/charts/stackradar-scanner`; the image and chart are
  cosigned and the image is pinned by digest.

[Unreleased]: https://github.com/lockdep/stackradar-scanner/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/lockdep/stackradar-scanner/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/lockdep/stackradar-scanner/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/lockdep/stackradar-scanner/releases/tag/v0.2.0
