# stackradar-scanner

<!-- The chart version in Chart.yaml is a build-time placeholder (see RELEASING.md),
     so these badges read the released version from GitHub rather than from the chart. -->
[![Release](https://img.shields.io/github/v/release/lockdep/stackradar-scanner?style=flat-square&label=Release)](https://github.com/lockdep/stackradar-scanner/releases/latest)
![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square)
[![Signed with cosign](https://img.shields.io/badge/Signed-cosign%20keyless-informational?style=flat-square)](#verifying-the-release)

Event-driven Kubernetes scanner that watches pod changes in real time, generates SBOMs with Syft, and uploads them to StackRadar for continuous software supply-chain visibility.

**Homepage:** <https://stackradar.io>

## Maintainers

| Name | Email | Url |
| ---- | ------ | --- |
| StackRadar | <support@stackradar.io> | <https://stackradar.io> |

## Source Code

* <https://github.com/lockdep/stackradar-scanner>

## Prerequisites

- Kubernetes 1.24+
- Helm 3.8+ or Helm 4 — 3.8 is where installing from an OCI registry stopped
  being experimental, and this chart is only published to one. Releases are
  tested against Helm 4; the chart uses nothing Helm 4-only, so Helm 3 keeps
  working until it reaches [end-of-life](https://helm.sh/blog/helm-v3-end-of-life/)
  in February 2027.
- A StackRadar account and API key ([sign up](https://stackradar.io))

## Installing the Chart

Always install an explicit `--version`. Published versions are immutable, so a
pinned version is a pin to exact bytes; omitting it silently upgrades you the
next time you run `helm install`.

```bash
helm install stackradar-scanner oci://ghcr.io/lockdep/charts/stackradar-scanner \
  --version <version> \
  --namespace stackradar --create-namespace
```

The latest version is on the [releases page](https://github.com/lockdep/stackradar-scanner/releases/latest),
or from the registry:

```bash
helm show chart oci://ghcr.io/lockdep/charts/stackradar-scanner | grep '^version:'
```

Then create the credentials Secret:

```bash
kubectl create secret generic stackradar-scanner \
  --namespace stackradar \
  --from-literal=cluster-id=<your-cluster-id> \
  --from-literal=api-key=<your-api-key>
```

## Passing credentials inline (CI/CD)

```bash
helm install stackradar-scanner oci://ghcr.io/lockdep/charts/stackradar-scanner \
  --version <version> \
  --namespace stackradar --create-namespace \
  --set stackradar.clusterId=<your-cluster-id> \
  --set stackradar.apiKey=<your-api-key>
```

## Using an existing Secret

```bash
helm install stackradar-scanner oci://ghcr.io/lockdep/charts/stackradar-scanner \
  --version <version> \
  --namespace stackradar \
  --set stackradar.existingSecret=my-secret
```

## Verifying the release

The chart and the image it deploys are signed with [cosign](https://docs.sigstore.dev/)
keyless signing — there is no public key to distribute. The signature is bound
to this repository's release workflow through a Sigstore certificate recorded in
the Rekor transparency log.

```bash
IDENTITY="^https://github.com/lockdep/stackradar-scanner/.github/workflows/release.yaml@refs/tags/"
ISSUER="https://token.actions.githubusercontent.com"

cosign verify \
  --certificate-identity-regexp "$IDENTITY" \
  --certificate-oidc-issuer "$ISSUER" \
  ghcr.io/lockdep/charts/stackradar-scanner:<version>

cosign verify \
  --certificate-identity-regexp "$IDENTITY" \
  --certificate-oidc-issuer "$ISSUER" \
  ghcr.io/lockdep/stackradar-scanner:<version>
```

Each release pins its image by digest in `image.digest`, so the deployed
container is the exact artifact that was built, signed, and attested by that
release — regardless of what the tag points at later. The image also carries
SLSA provenance and an SBOM attestation:

```bash
cosign verify-attestation --type slsaprovenance \
  --certificate-identity-regexp "^https://github.com/lockdep/stackradar-scanner/" \
  --certificate-oidc-issuer "$ISSUER" \
  ghcr.io/lockdep/stackradar-scanner:<version>
```

## What you are installing

The scanner runs with cluster-wide read access, so being able to check what it
actually does is part of the deal:

- The **source** is readable at
  [lockdep/stackradar-scanner](https://github.com/lockdep/stackradar-scanner).
- Every published image carries an **SBOM attestation** listing every package
  inside it, generated at build time by BuildKit — inspect it without pulling
  the image:

  ```bash
  cosign download attestation \
    --predicate-type https://spdx.dev/Document \
    ghcr.io/lockdep/stackradar-scanner:<version> | jq -r '.payload' | base64 -d | jq .predicate
  ```

- The **RBAC the chart grants** is in `templates/clusterrole.yaml` in this
  chart; `helm template` renders it before you install anything.

## License

Source-available under the [PolyForm Shield License 1.0.0](https://polyformproject.org/licenses/shield/1.0.0),
a copy of which ships in this chart as `LICENSE.md`. You may read, run, modify
and self-host the scanner. You may not use it to provide a product that
competes with StackRadar. This is not an open source license.

## Versioning

Chart version and application version are always the same number, cut from a
`v*` git tag. `0.x` releases may make breaking changes in the minor position.
See [RELEASING.md](https://github.com/lockdep/stackradar-scanner/blob/main/RELEASING.md).

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| affinity | object | `{}` | Affinity rules for fine-grained pod placement. |
| dockerConfigSecret | string | `""` | Name of a `kubernetes.io/dockerconfigjson` Secret to mount as a docker config, allowing syft to pull from private registries. Create with: `kubectl create secret generic registry-credentials --from-file=.dockerconfigjson=...` |
| fullnameOverride | string | `""` | Override the full name of the chart's resources, replacing the `<release>-<chart>` default entirely. |
| image.digest | string | `""` | Image digest (sha256:...). Stamped by the release workflow so every published chart pins the exact image bytes it was tested against, and set empty on dev builds. The digest wins over the tag: to run a different image you must clear this as well (`--set image.tag=X --set image.digest=""`), otherwise the tag is cosmetic. |
| image.pullPolicy | string | `"Always"` | Image pull policy. |
| image.repository | string | `"ghcr.io/lockdep/stackradar-scanner"` | Container image repository. |
| image.tag | string | `""` | Image tag. Defaults to the chart appVersion, which for a released chart is the release version — leave empty so the chart and the image it deploys stay in lockstep. |
| imagePullSecrets | list | `[]` | List of image pull secrets for the scanner pod. |
| nameOverride | string | `""` | Override the chart name used in resource names and labels. |
| nodeSelector | object | `{}` | Node selector for pod scheduling. |
| podSecurityContext | object | `{"fsGroup":65534,"runAsGroup":65534,"runAsNonRoot":true,"runAsUser":65534}` | Pod-level security context. |
| priorityClassName | string | `""` | PriorityClassName so the scanner yields resources to application pods. |
| scanner.excludeNamespaces | string | `"kube-system,kube-public,kube-node-lease"` | Comma-separated list of namespaces to exclude from scanning. |
| scanner.includeNamespaces | string | `""` | Comma-separated list of namespaces to scan. When set, ONLY these namespaces are scanned. |
| scanner.resolveImagePullSecrets | string | `"true"` | Resolve imagePullSecrets from workload pod specs for private registry auth. Requires `secrets get` permission in the ClusterRole. |
| scanner.skipExistingDigests | string | `"true"` | Skip images whose digest is already indexed in StackRadar. Eliminates redundant syft runs when the image binary has not changed. |
| scanner.syftTimeoutMs | string | `"300000"` | Timeout per image scan in milliseconds. |
| securityContext | object | `{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"readOnlyRootFilesystem":true}` | Container-level security context. |
| serviceAccount.create | bool | `true` | Create a ServiceAccount for the scanner. |
| serviceAccount.name | string | `""` | Override the ServiceAccount name. Defaults to the release name when empty. |
| stackradar.apiKey | string | `""` | API key for StackRadar. If set, the chart creates the credentials Secret automatically. |
| stackradar.apiUrl | string | `"https://api.stackradar.io"` | StackRadar API endpoint. Override only when running against a self-hosted instance. |
| stackradar.clusterId | string | `""` | Cluster ID to identify this cluster in StackRadar. Can be passed inline at install time instead of via a Secret (avoid in day-to-day use — values land on disk and in CI logs). |
| stackradar.existingSecret | string | `""` | Name of a pre-existing Secret with keys `cluster-id` and `api-key`. When set, the chart skips Secret creation and the Deployment reads from this Secret instead. Compatible with sealed-secrets, external-secrets, and SOPS workflows. |
| stackradar.existingSecretKeyApiKey | string | `""` | Key within `existingSecret` holding the API key. Defaults to `api-key` when empty. |
| stackradar.existingSecretKeyClusterId | string | `""` | Key within `existingSecret` holding the cluster ID. Defaults to `cluster-id` when empty. |
| tolerations | list | `[]` | Tolerations for pod scheduling on tainted nodes. |
| watcher.concurrentScans | string | `"1"` | Maximum number of concurrent syft scans. Each invocation can use 300–600 MiB for large images; keeping this at 1 avoids OOM kills. |
| watcher.enabled | bool | `true` | Enable the event-driven watcher with periodic sweeps. |
| watcher.resources | object | `{"limits":{"cpu":"2000m","memory":"1Gi"},"requests":{"cpu":"50m","memory":"512Mi"}}` | Resource requests and limits for the watcher Deployment. |
| watcher.sweepIntervalMs | string | `"21600000"` | How often to run a full pod sweep in milliseconds. Set to 0 to disable periodic sweeps and rely solely on the informer. |
