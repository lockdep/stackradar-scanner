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

[Unreleased]: https://github.com/lockdep/stackradar-scanner/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/lockdep/stackradar-scanner/releases/tag/v0.2.0
