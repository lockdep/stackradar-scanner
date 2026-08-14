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

## [0.1.2] - 2026-08-14

### Added

- `networkPolicy.enabled` and `networkPolicy.egress` — a NetworkPolicy for the
  scanner pod, so what the agent can reach is an object you can read with
  `kubectl get networkpolicy` rather than a paragraph in our README. Ingress is
  the kubelet's health probes and nothing else; egress defaults to DNS, the
  Kubernetes API server, and TCP 443 for the StackRadar API and your registries,
  plus the cloud metadata endpoint where workload identity is configured.

  Off by default, and deliberately so: a registry that sits outside the default
  rules stops being scanned, which is exactly the quiet failure the rest of this
  agent is built to avoid. Turn it on when you have somewhere to test it, and
  narrow it with `networkPolicy.egress` — a list you set replaces the defaults
  rather than adding to them, so include a DNS rule of your own. Behind a proxy
  the whole policy collapses to DNS plus the proxy's address.

  A CNI that does not enforce NetworkPolicy accepts the object and ignores it.
  See [Restricting the agent's network](helm/README.md#restricting-the-agents-network),
  which leads with how to tell the policy apart from a credentials problem when
  pulls start failing.

- `scanner.excludeImages` — a comma-separated list of glob patterns for images
  you never want scanned, whatever namespace they run in. Namespace filtering
  was the only tool for this, and it is the wrong shape for the images people
  actually want to skip: `registry.k8s.io/pause` is on every pod in every
  namespace, and injected sidecars are cluster-wide by design. A matching image
  costs no syft run, no upload, and no rows in your dashboard.

  Patterns are matched against the image name with its `:tag` and
  `@sha256:...` stripped, so one pattern keeps working as the tag moves. `*` is
  the only wildcard and it spans `/`; everything else is literal and a pattern
  has to match the whole name, so `registry.k8s.io/*` covers
  `registry.k8s.io/sig-storage/csi-provisioner` but not
  `myregistry.io/registry.k8s.io-mirror/app`. A pattern that carries a tag or a
  digest could never match, so the agent drops it and logs a warning naming it
  rather than leaving you with one that quietly does nothing — and one bad
  pattern does not disturb the rest of the list.

  The default is empty and renders no env var at all, so nothing changes for
  existing installs. Once you set it, the agent lists the active patterns in its
  startup log line and logs each skipped image at `debug` — worth checking after
  a change, since an over-broad pattern removes coverage with no other signal
  that it did.

- `watcher.healthPort` — the port the agent's new liveness and readiness
  endpoints listen on, `8081` by default. Nothing exposes it through a Service;
  the kubelet reaches it on the pod IP. Change it only if something else in the
  pod's network namespace already listens there, and note that a cluster with a
  default-deny NetworkPolicy has to allow the kubelet in on it or the probes
  fail.

- `serviceAccount.annotations`, `podLabels` and `podAnnotations` — pull from
  your cloud's own registry using workload identity instead of a static
  credential. Annotate the ServiceAccount for EKS IRSA
  (`eks.amazonaws.com/role-arn`) or GKE Workload Identity
  (`iam.gke.io/gcp-service-account`); Azure Workload Identity reads a pod label
  and a pod annotation, so it needs the other two. Previously the only way to
  reach ECR, ACR or Artifact Registry was `dockerConfigSecret` — which on ECR
  means a 12-hour token and a CronJob of your own to refresh it.

  Not yet verified end to end on any of the three clouds: the chart renders what
  each mechanism documents and the injected credentials reach the pod, but
  whether syft's registry client picks them up without a credential helper is
  untested per cloud. `helm/README.md` says so, and says which knob goes with
  which cloud. `dockerConfigSecret` still works and is unchanged.

  `podLabels` cannot displace `app.kubernetes.io/name`, `/instance` or
  `/component` — they are in the Deployment's selector, which is immutable
  after creation, so the chart's own labels win the merge rather than letting
  you build a release that only fails on the next upgrade. All three values
  default to empty and render nothing, so nothing changes for existing installs.

- `scanner.imagePullSecretNames` — name the pull secrets the scanner may read
  and its `secrets get` grant narrows to exactly those, through RBAC
  `resourceNames`. Previously the only choice was cluster-wide `secrets get` or
  no private-registry support at all. The default is empty, which renders the
  same unrestricted rule as before, so nothing changes until you set it.

  Worth knowing before you do: `resourceNames` in a ClusterRole matches a name
  in *every* namespace — it is not a namespace-scoped grant — and a Secret left
  off the list is denied, so images that needed it fall back to an anonymous
  pull. The agent logs a warning naming the Secret and the namespace and
  finishes the rest of the scan.

- `caBundle.configMapName`, `caBundle.secretName` and `caBundle.key` — trust a
  private CA, for clusters behind a proxy that terminates and re-signs TLS.
  Point one of the first two at a ConfigMap or Secret holding a PEM bundle and
  it is mounted read-only at `/etc/ssl/stackradar/`; the pod gets
  `NODE_EXTRA_CA_CERTS` for the agent's own traffic and `SSL_CERT_DIR` for
  syft's registry pulls. Without it the agent fails with `unable to verify the
  first certificate` and the only workaround was to turn certificate
  verification off entirely.

  Your CA is *added* to the public roots rather than replacing them, so images
  pulled straight from a public registry keep working alongside those that go
  through the proxy. `caBundle.key` names the key inside the object and defaults
  to `ca-certificates.crt`. Setting both a ConfigMap and a Secret fails the
  install instead of picking one. Both are empty by default and render no
  volume and no environment variables, so nothing changes for existing installs.

- `proxy.httpProxy`, `proxy.httpsProxy` and `proxy.noProxy` — run the scanner in
  a cluster with no direct internet egress. Setting either URL puts
  `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` on the pod in both upper and lower
  case, and the agent now routes its own HTTP through the proxy as well.

  That last part is why this needed an agent release and not just a chart value:
  Node's built-in `fetch` ignores the conventional proxy variables, so setting
  them by hand previously fixed Syft's registry pulls while every call to the
  StackRadar API kept failing — the agent started, logged a heartbeat failure,
  and indexed nothing.

  `kubernetes.default.svc`, `.svc`, `.cluster.local`, `localhost` and
  `127.0.0.1` are always appended to `NO_PROXY`, so Kubernetes API traffic never
  goes through the proxy; add your internal registries to `proxy.noProxy` so
  image pulls do not either. Include the scheme in the URLs — `proxy.corp:8080`
  is rejected at install time. The startup log names the proxy with any
  `user:pass@` redacted. Both URLs are empty by default and render no
  environment variables at all, so nothing changes for existing installs.

  If your proxy also terminates TLS, point `caBundle.configMapName` at its CA —
  see the entry below.

### Changed

- The documented Helm requirement is now `3.8+ or Helm 4`, replacing a `3.10+`
  that predated Helm 4 and understated what the chart actually needs: 3.8 is
  the floor for installing from an OCI registry, which is the only way this
  chart is published. Releases are now tested against Helm 4. Nothing about
  the chart changed — it uses no Helm 4-only features, so existing Helm 3
  installs are unaffected.

### Fixed

- The watcher's liveness probe can now fail. It used to run
  `node -e "process.exit(0)"`, which starts a second Node process and exits 0
  no matter what the agent is doing — it proved the image contains a Node
  binary and nothing else. The probe now asks the running process, over HTTP on
  `watcher.healthPort`.

  The failure this catches is the one worth catching. When the pod's watch on
  the Kubernetes API breaks — an expired token, RBAC revoked, a NetworkPolicy
  that no longer allows the API server — the agent retries every five seconds
  and otherwise carries on: alive, Ready, heartbeating, and scanning nothing.
  Your cluster looked healthy in StackRadar the whole time, and the first
  evidence otherwise was a vulnerability nobody was told about. `/healthz` now
  reports non-2xx once the watch has been down for three failed restarts, and
  the kubelet restarts the pod after three more failures a minute apart.

  Deliberately not part of it: how long since the last pod event. A cluster
  whose workloads have not changed since last night produces no events and is
  perfectly healthy.

  There is also a readiness probe now, on `/readyz`, which reports not-ready
  until the informer's first sync completes — so `helm upgrade --wait` and
  `kubectl rollout status` stop reporting a large cluster's rollout complete
  before the agent has seen a single pod.

  You may now see the watcher restart where it previously sat there quietly
  doing nothing, which is the point. A brief API server outage will not do it:
  a fault has to persist for about three minutes.

## [0.1.0] - 2026-08-13

The first release cut from a tag, and the first one whose bytes are immutable
and signed.

A `0.1.0` chart was published from `main` before this process existed and has
since been deleted from GHCR. Everything below is written against that chart,
because the dogfood cluster ran it; a fresh install has nothing to carry over
and can read this as the starting point.

### Added

- Four values the templates already read but that were declared nowhere — not in
  `values.yaml`, not in the schema, not in the configuration reference:
  `stackradar.existingSecretKeyApiKey`, `stackradar.existingSecretKeyClusterId`,
  `nameOverride` and `fullnameOverride`. All four are now documented and
  validated.
- Cosign keyless signatures on both the image and the chart, plus SLSA
  provenance and an SBOM attestation on the image. There is no public key to
  distribute: the signature is bound to this repository's release workflow at
  the tag. Verification commands are in `README.md`.
- A heartbeat that reports liveness, the cluster ID and the running agent
  version, so a cluster on an outdated chart is visible in the StackRadar UI.
- The full license text travels with every artifact: `LICENSE.md` in the chart
  `.tgz` and at `/app/LICENSE.md` in the image, as PolyForm Shield 1.0.0
  requires.

### Changed

- **The chart's ClusterRole is smaller.** It is now `pods: list,watch` plus the
  optional `secrets: get`. The cluster-wide `list` grants on Deployments,
  StatefulSets, DaemonSets, CronJobs and Jobs are gone — they existed for a
  batch scanner the chart never deployed. Everything the agent reports is
  derived from pods.
- **Unknown values are now rejected.** `values.schema.json` sets
  `additionalProperties: false`, so a key the chart does not define fails the
  install and names itself, instead of being silently ignored. This is breaking
  for anyone passing extra keys today: `helm template` your values against this
  version before upgrading. Free-form objects — `resources`, the security
  contexts, `nodeSelector`, `affinity` — stay open on purpose, because their
  contents are Kubernetes' to validate.
- The chart pins its image by digest, so the version you install resolves to the
  exact bytes that release built and signed, whatever the tag points at later.
- The agent falls back to the ambient kubeconfig when no service-account token is
  mounted, and logs which of the two it used. This makes local runs possible; in
  a pod, that fallback warning means the ServiceAccount is missing.

### Removed

- The one-shot batch scanner. The chart only ever ran the watcher, so this
  removes a deployment mode nothing used along with the RBAC it needed. The
  `scanner.schedule` value that configured it was never read by any template and
  is now rejected by the schema.

### Fixed

- **`scanner.includeNamespaces` could silently disable all scanning.** A value
  that parsed to no namespaces — `" , "`, a trailing comma, a list of blanks —
  produced an empty allowlist that matched nothing, so the agent scanned no
  namespace at all while the pod stayed ready and the heartbeat kept reporting.
  Nothing surfaced the failure. Such a value now means "no allowlist", the same
  as leaving it unset. An install in that state goes from scanning nothing to
  scanning everything outside the default namespace excludes.
- **`image.tag` was ignored when `image.digest` was set.** The digest wins when
  both are rendered, so `--set image.tag=...` against a chart that pins a digest
  ran the pinned image while `kubectl describe` showed the tag. Setting both now
  fails the render with a message naming the two values and the flags that
  resolve it.

### Security

- Syft is installed from a release binary whose checksums are verified with
  cosign against Anchore's release signature, then matched byte for byte against
  the tarball. It was previously installed by piping an unpinned installer script
  from a mutable branch into a shell at build time — arbitrary code inside the
  build of an agent that runs with cluster-wide read.
- The base image is pinned by digest in every build stage, so two builds of the
  same commit cannot ship different layers, and therefore cannot differ in the
  CVEs the SBOM reports.
- The pod runs non-root (uid 65534) with a read-only root filesystem, all Linux
  capabilities dropped and no privilege escalation.

[Unreleased]: https://github.com/lockdep/stackradar-scanner/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/lockdep/stackradar-scanner/compare/v0.1.1...v0.1.2
[0.1.0]: https://github.com/lockdep/stackradar-scanner/releases/tag/v0.1.0
