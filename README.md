# StackRadar Scanner

[![Release](https://img.shields.io/github/v/release/lockdep/stackradar-scanner?style=flat-square&label=Release)](https://github.com/lockdep/stackradar-scanner/releases/latest)
[![License: PolyForm Shield 1.0.0](https://img.shields.io/badge/License-PolyForm%20Shield%201.0.0-informational?style=flat-square)](LICENSE.md)
[![Signed with cosign](https://img.shields.io/badge/Signed-cosign%20keyless-informational?style=flat-square)](#verifying-what-you-install)

Event-driven Kubernetes agent that watches pod changes in real time, generates
an SBOM for every container image running in your cluster with
[Syft](https://github.com/anchore/syft), and uploads it to
[StackRadar](https://stackradar.io) for continuous software supply-chain
visibility.

This agent runs with cluster-wide read access, so the source is published for
you to audit. It is **source-available, not open source** — see
[License](#license).

## How it works

A single `watcher` Deployment runs three loops:

| Loop | Default cadence | What it does |
| --- | --- | --- |
| Informer | real time | Watches pod add/update events and scans images as they appear |
| Sweep | every 6 h | Full pod list, to catch anything the informer missed |
| Heartbeat | every 5 min | Reports liveness and the running agent version |
| Health endpoints | on request | Answers the kubelet's liveness and readiness probes on port 8081 |

For each container image it finds, the agent asks StackRadar whether that image
digest has already been indexed. If not, it pulls the image **directly from the
registry** (`syft registry:<ref>`, not through the node's container runtime),
generates a CycloneDX SBOM, uploads it, and remembers the digest so restarts and
re-syncs don't cause repeated scans.

Scans are serialised by default (`watcher.concurrentScans: 1`) because syft can
use 300–600 MiB on a large image.

## Install

```bash
helm install stackradar-scanner oci://ghcr.io/lockdep/charts/stackradar-scanner \
  --version <version> \
  --namespace stackradar --create-namespace

kubectl create secret generic stackradar-scanner \
  --namespace stackradar \
  --from-literal=cluster-id=<your-cluster-id> \
  --from-literal=api-key=<your-api-key>
```

Always pass an explicit `--version` — published versions are immutable, so
pinning one pins exact bytes. The latest is on the
[releases page](https://github.com/lockdep/stackradar-scanner/releases/latest).

Needs Helm 3.8+ or Helm 4 — 3.8 is the floor for installing from an OCI
registry. Releases are tested against Helm 4.

SBOM upload requires a **cluster-scoped** API key; org-scoped keys are rejected.
Full configuration reference: [`helm/README.md`](helm/README.md).

## What it does in your cluster

### Permissions it requests

Rendered from [`helm/templates/clusterrole.yaml`](helm/templates/clusterrole.yaml)
— run `helm template` to see exactly what you would apply.

| Resource | Verbs | Why |
| --- | --- | --- |
| `pods` | `list`, `watch` | Discover running images; `watch` drives the real-time scanning, `list` backs the informer's initial sync and the periodic sweep |
| `secrets` | `get` | Resolve `imagePullSecrets` so private-registry images can be pulled — [narrow this to named Secrets](#narrowing-secrets-get) or turn it off |

That is the whole ClusterRole. The agent reads no Deployments, StatefulSets,
DaemonSets, CronJobs or Jobs — everything it reports is derived from pods.

### Narrowing `secrets get`

By default the `secrets get` grant is cluster-wide. The agent uses far less than
that — it reads only the Secrets named in a workload's `imagePullSecrets`, and
uses them to build a temporary Docker config for syft — so name your pull
secrets and the grant shrinks to exactly those, via RBAC `resourceNames`:

```bash
--set 'scanner.imagePullSecretNames={regcred,ghcr-creds}'
```

```yaml
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get"]
  resourceNames: ["regcred", "ghcr-creds"]
```

This is the recommended setting, and it is safe to narrow because the agent only
ever `get`s a Secret by name — it never lists or watches them. Two things to
know before you set it:

- **It is a name match, not a namespace match.** `resourceNames` in a
  ClusterRole has no namespace to scope to, so a Secret called `regcred` is
  readable in *every* namespace. Use distinct names where that matters.
- **A new registry needs a list update.** A Secret you leave off is denied, and
  images that needed it fall back to an anonymous pull — which fails for a
  private registry. The agent logs a warning naming the Secret and the
  namespace, and carries on with the rest of the scan.

If you pull only from public registries, or you mount one static pull secret via
`dockerConfigSecret`, turn resolution off entirely and the rule disappears from
the ClusterRole:

```bash
--set scanner.resolveImagePullSecrets=false
```

### What leaves your cluster

Sent to your StackRadar API endpoint, per image:

- The **CycloneDX SBOM** produced by syft — the package inventory of the image.
- **Image identity**: registry host, image reference, image digest, tag.
- **Placement**: namespace, and the workload kind (`Deployment`, `StatefulSet`, …).
- **A workload name**, taken from the `app.kubernetes.io/name` or `app` pod
  label, falling back to the pod name with its generated suffix stripped.
- **Allowlisted pod labels** — exactly these nine keys, and no others:
  `app`, `version`, `app.kubernetes.io/{name,version,component,part-of,instance,managed-by}`,
  `helm.sh/chart`.
- **Allowlisted pod annotations** — exactly these three:
  `meta.helm.sh/release-name`, `meta.helm.sh/release-namespace`,
  `argocd.argoproj.io/tracking-id`.
- Your cluster ID, and the agent version in an `X-Scanner-Version` header.

The allowlists are literal `Set`s in
[`src/lib/scan.ts`](src/lib/scan.ts) (`RELEVANT_POD_LABEL_KEYS`,
`RELEVANT_POD_ANNOTATION_KEYS`) — a label or annotation not named there is
dropped before anything is sent.

### What does not leave your cluster

- **Registry credentials.** Resolved `imagePullSecrets` are written to a
  temporary Docker config on the pod's `emptyDir` and handed to syft to pull
  with. They are never transmitted.
- **Secret or ConfigMap contents**, environment variables, and command-line
  arguments of your workloads.
- **Container filesystems.** Only the package inventory syft derives from the
  image is uploaded, never file contents.
- **Any label or annotation outside the allowlists above**, and raw pod names.

### Namespaces

`kube-system`, `kube-public` and `kube-node-lease` are excluded by default. Set
`scanner.includeNamespaces` to restrict scanning to an explicit list instead.

### Security posture of the pod

Non-root (uid 65534), read-only root filesystem, all Linux capabilities dropped,
no privilege escalation, `/tmp` on an `emptyDir`. The pod needs egress to your
StackRadar endpoint, to the Kubernetes API, and to whichever registries host
your images.

It listens on one port — `8081`, named `health`, configurable via
`watcher.healthPort` — serving `/healthz` and `/readyz` to the kubelet and
nothing else. No Service points at it, so it is reachable only from inside the
cluster on the pod IP, and the responses carry the agent's own state (is the
pod watch established, when did the last heartbeat succeed) rather than
anything about your workloads. If you run default-deny NetworkPolicies, allow
the kubelet in on that port or the probes fail and the pod restarts in a loop.

Where that egress goes through a corporate proxy, set `proxy.httpsProxy` (see
[Behind a corporate proxy](helm/README.md#behind-a-corporate-proxy)). Kubernetes
API traffic is exempted from the proxy automatically and stays in the cluster.

Where that proxy also terminates TLS, point `caBundle.configMapName` at a
ConfigMap holding your CA (see
[Behind a TLS-intercepting proxy](helm/README.md#behind-a-tls-intercepting-proxy)).
It is mounted read-only and *added* to the public roots, so the agent keeps
verifying every certificate it is presented — including the ones it uploads
your SBOM data over.

## Verifying what you install

Every release is signed with [cosign](https://docs.sigstore.dev/) keyless
signing. There is no public key to distribute — the signature is bound to this
repository's release workflow by a Sigstore certificate recorded in the public
Rekor transparency log.

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

Each chart pins its image by digest, so what you deploy is the exact artifact
that release built, signed and attested — regardless of where the tag points
later.

The images carry an SBOM attestation and SLSA provenance, so you can inventory
the agent itself before running it:

```bash
cosign download attestation \
  --predicate-type https://spdx.dev/Document \
  ghcr.io/lockdep/stackradar-scanner:<version> \
  | jq -r '.payload' | base64 -d | jq '.predicate'
```

## Development

Requires Node 22 and pnpm (via corepack — the version is pinned in
`package.json`).

```bash
corepack enable
pnpm install

pnpm test         # vitest
pnpm build        # tsc

pnpm dev          # the watcher (src/watch.ts), with pretty logs
```

`pnpm dev` runs against your ambient kubeconfig: the agent uses the mounted
service-account token when one is present and falls back to `KUBECONFIG` when it
is not, logging which of the two it picked. Seeing the fallback warning inside a
pod means the ServiceAccount is missing.

It also needs `STACKRADAR_API_URL` and `STACKRADAR_API_KEY` in the environment;
`STACKRADAR_CLUSTER_ID` identifies the cluster to the API.

Regenerate the chart's values table after editing `helm/values.yaml`:

```bash
helm-docs --chart-search-root=helm --template-files=README.md.gotmpl
```

CI fails if you forget: `helm/README.md` is the configuration reference
customers read, and a stale values table is worse than none.

## Versioning and releases

Chart version and application version are always the same number, cut from a
`v*` git tag; published versions are immutable. See [RELEASING.md](RELEASING.md).

What changed in each version — including anything that changes behaviour for an
existing install — is in [CHANGELOG.md](CHANGELOG.md). The release workflow
publishes that section as the GitHub Release notes and as the chart's ArtifactHub
changelog, so the three cannot drift.

The version the chart deploys is reported back on every heartbeat, so clusters
running an outdated agent are visible in the StackRadar UI.

## License

[PolyForm Shield License 1.0.0](LICENSE.md). You may read, run, modify and
self-host this software. You may **not** use it to provide a product that
competes with StackRadar. This is a source-available license, not an open source
one.
