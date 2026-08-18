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

### Fixed

- **Digest-pinned workloads no longer appear as an image called `sha256` with a
  64-character "tag".** When a pod pins its image by digest, the runtime has no
  tag to report, and containerd fills the container status's `image` field with
  a bare image ID — `sha256:` followed by 64 hex characters, no name at all.
  The agent reported that string as the image's display name, and splitting it
  on the colon filed the workload under a project named `sha256` with the hex
  as its tag: unreadable in the workloads table, and useless for chart and
  upgrade matching, since every digest-pinned image across the fleet collapsed
  into the same fake `sha256` project. The agent now recognises the bare-ID
  form and names such images by their pull reference instead, which comes from
  the status's `imageID` and still carries the real registry and repository.
  Actual references are unaffected — a repository genuinely named `sha256`
  with a normal tag still parses as one.

## [0.1.8] - 2026-08-17

### Added

- **The agent reports the cluster's Kubernetes version on its heartbeat.**
  Charts declare the Kubernetes range they support (`kubeVersion`), and
  StackRadar can now warn when a suggested chart upgrade requires a newer
  Kubernetes than the cluster runs — but only if it knows the cluster's
  version. The agent reads `/version` (part of the discovery API every
  authenticated principal can already reach — no RBAC change) at startup and
  on the heartbeat cadence, and sends the `gitVersion` string, e.g.
  `v1.29.4+k3s1`, in an `X-Kubernetes-Version` header. If the read fails the
  header is simply absent; the server never treats absence as a value.

## [0.1.7] - 2026-08-17

### Added

- **A Helm release now reports its chart repository when ArgoCD names it.**
  No object Helm leaves on a workload says where its chart was published, so
  every release's repository URL has been `NULL` since releases were first
  reported — and "every release of chart X across your fleet" was a match on
  the chart's *name*, which several repositories legitimately share. The
  agent now joins the two layers it already collects: when a chart-source
  ArgoCD `Application` delivers a release, the application's `repoURL` is
  reported as the release's chart repository. In StackRadar that upgrades
  chart matching from a labelled guess to a fact, which is what its upgrade
  suggestions ("a newer version of this chart exists") are allowed to build
  on.

  The join is deliberately narrow, because a wrong repository is worse than
  none. Only an `Application` whose source is a *chart* qualifies — a
  git-path source's `repoURL` is a git repository, not where the chart is
  published, so those releases honestly keep `NULL`. And the application's
  chart name must agree with the release's own (or the release must never
  have learned one): pods of an umbrella release sometimes label themselves
  with a subchart, and reporting the subchart at the umbrella's repository
  would be a false statement about where it lives.

  Nothing to configure and no new RBAC: it reads the same `Application`
  objects 0.1.6 already collects, and inherits their
  `--set scanner.resolveArgocdApplications=false` off switch. Flux's
  `HelmRepository` is the natural second source and is not read yet.

## [0.1.6] - 2026-08-16

### Fixed

- **Chart-managed workloads no longer show up under "Unmanaged".** 0.1.5 read
  the Helm release off pod labels, which fixed the previous release's zero
  findings but left a second, quieter version of the same problem: the pod is
  the one object in the chain that usually does *not* carry chart context.
  Helm writes `meta.helm.sh/release-name` onto the object it applies, never
  into the pod template; ArgoCD annotates what it applies and nothing
  propagates that downward; and an operator that generates a StatefulSet from a
  custom resource writes its own labels for the pods it manages, dropping the
  chart labels on the way through. On a 41-workload dev cluster that was 11
  workloads filed as unmanaged that a chart demonstrably manages —
  `kube-prometheus-stack`'s alertmanager and prometheus among them — plus
  `loki` and `alloy` reported as releases with no chart name at all.

  The agent now reads the **metadata** of each pod's controller and merges it
  *under* the pod's own, so the pod still wins any key both carry. That is one
  `get` per distinct controller for the life of the process, on the 5-minute
  inventory path rather than the pod watch, and it asks the API server for
  `PartialObjectMetadata` — labels and annotations, never the workload spec.
  The same allowlist that has always applied to pod metadata is applied to it.

  Two rules changed with it, both measured against the
  [recommended labels](https://kubernetes.io/docs/concepts/overview/working-with-objects/common-labels/)
  spec. `app.kubernetes.io/managed-by` is no longer a veto: the spec defines it
  as the tool that *operates* an application, so `prometheus-operator` on a
  Helm-packaged StatefulSet is a true statement rather than a contradiction,
  and it is absent on three quarters of a typical fleet anyway. A release is
  now claimed only on *positive* Helm evidence. And `release` — an unprefixed
  key, which the spec says is private to users — is read as a release name only
  when the same object corroborates it with `heritage: Helm` or a well-formed
  chart label; uncorroborated, `app.kubernetes.io/instance` wins, so somebody's
  `release: stable` channel marker never becomes a release name.

  New RBAC: `get` on `deployments`, `statefulsets`, `daemonsets`,
  `replicasets`, `jobs` and `cronjobs`. No `list`, no `watch`. Denied, the
  agent logs one line and falls back to 0.1.5's behaviour rather than failing
  the report — and the report now says which of the two happened, so
  StackRadar can tell "no chart claims this" from "the agent was not allowed to
  look". Turn the whole thing off with
  `--set scanner.resolveWorkloadOwners=false` and the rules disappear from the
  ClusterRole.

### Added

- **GitOps delivery is reported as its own layer, beside the chart.** A
  workload delivered by ArgoCD and packaged by a Helm chart now carries both,
  because both are true and each answers a different half of the same question:
  the chart version is what a CVE advisory is written against, and the Argo
  app's `targetRevision` is where you change it. StackRadar gains an **App**
  grouping next to Chart; neither replaces the other, and their unattributed
  buckets are genuinely different sets — the StackRadar agent itself has a
  chart and no app.

  `argocd.argoproj.io/tracking-id` moves from the pod-annotation allowlist to
  the controller one, which is where ArgoCD actually writes it — it had been on
  the pod list since the first release and had never once matched. Where the
  `Application` object is readable, the repository URL, chart, path and target
  revision come with it. Multi-source `Application`s (`spec.sources`) are
  read, not just the singular `spec.source`.

  New RBAC: `list` on `argoproj.io/applications`, in one namespace
  (`scanner.argocdNamespace`, default `argocd`). A cluster with no ArgoCD
  answers 404 once and is never asked again. `--set
  scanner.resolveArgocdApplications=false` removes the rule.

- **The unmanaged group is sub-grouped by `app.kubernetes.io/part-of`.** The
  workloads that genuinely have no chart and no app — ArgoCD's own components,
  cilium and its hubble siblings, the cloud provider's add-ons — are grouped by
  the suite they belong to instead of sitting in one flat pile. Presentation
  only: `part-of` names a suite, not a package, and it never creates a release
  or an application row.

### Changed

- **Inventory payload v3.** `releases[].source` is removed — every release is a
  Helm release now that delivery has its own `applications[]` array, and a
  field whose only value was `"helm"` was an invitation to write `"argocd"`
  into it later. Workloads gain an `application` reference alongside `release`,
  and the report says whether controller metadata could be collected at all.
  Requires a control plane that speaks v3; an older one replies 400 and the
  agent logs it once per interval and keeps uploading SBOMs, exactly as before.

- **The reported workload labels are the merged set.** Pod labels over
  controller labels, pod winning. In practice this means
  `app.kubernetes.io/part-of` and the chart labels now arrive for workloads
  whose pod template never carried them. Still the same twelve-key allowlist,
  now applied to both objects and snapshot-tested separately for each.

## [0.1.5] - 2026-08-15

### Fixed

- **Helm releases are now actually detected; 0.1.4 found none on most
  clusters.** 0.1.4 started reporting the Helm release and chart behind each
  workload, but read them from the `meta.helm.sh/release-name` and
  `-namespace` annotations. Helm writes those onto the objects it manages —
  the Deployment, the StatefulSet — and nothing copies them down into the pod
  template, so no pod carries them and the agent reported zero releases on a
  cluster where `helm list` shows a dozen. A chart applied by ArgoCD or Flux
  has them nowhere at all: Helm rendered the manifests, something else
  installed them. Grouping by chart in StackRadar was empty for almost
  everyone.

  The release now comes from the standard labels every chart templates into
  its pod spec — `app.kubernetes.io/instance` for the release name,
  `helm.sh/chart` for `<chart>-<version>` — with Helm's pre-3.0 spelling
  (`release`, `chart`, `heritage`) as a fallback for charts that never
  migrated. The annotations are still honoured first where they do appear:
  they are the only source that can name a release living in a *different*
  namespace than the workload, and without them the workload's own namespace
  is used, which is correct for every single-namespace release.

  Two things it deliberately does not do. It does not invent a release when
  `app.kubernetes.io/managed-by` (or `heritage`) names a controller that is
  not Helm — prometheus-operator stamps an `instance` label on StatefulSets it
  generates itself, and that name would never show up in `helm list`. And for
  an umbrella chart it reports the umbrella rather than whichever subchart the
  last pod happened to carry, so `kube-prometheus-stack` stays
  `kube-prometheus-stack` instead of alternating between `grafana` and
  `kube-state-metrics` from one report to the next.

  Nothing to configure and no new RBAC. Three keys join the pod-label
  allowlist — `release`, `chart` and `heritage`, twelve in total — and like
  the rest of that list they ride the inventory report, not the SBOM.

### Changed

- **A control plane with no inventory endpoint now says so at `warn`.** The
  404 was logged at `debug`, which a default install never prints, so an agent
  whose every inventory report was being rejected looked perfectly healthy
  while namespaces, workloads and Helm releases silently never landed — which
  is exactly how a route missing from an ingress allowlist went unnoticed. The
  message now names what is not being recorded and what to check. As before,
  the 404 does not stop SBOM uploads, so an agent ahead of its control plane
  keeps finding vulnerabilities.

## [0.1.4] - 2026-08-15

### Changed

- **The agent now scans each image once for the whole cluster, not once per
  place it runs.** An image deployed into five namespaces used to mean five
  pulls, five syft runs and five uploads of an identical component list; it is
  now one of each. On a fleet that shares base images this is the difference
  between minutes and tens of minutes for a first scan, and it scales with how
  much your images have in common rather than with how many workloads you run.

  Nothing to configure. If you set `SEEN_DIGESTS_MAX`, note that it now counts
  distinct images rather than image-and-place pairs, so the default goes much
  further than it used to.

- **Workload inventory reports now carry deployment context**, and are the
  agent's primary way of telling StackRadar what is running. Each report
  describes namespaces, workloads and containers as the nested things they are,
  rather than a flat list of `<workload>/<container>` strings, and adds:

  - the **workload kind** — Deployment, StatefulSet, DaemonSet, Job — resolved
    from `ownerReferences` instead of being reported as `Pod` for everything.
    This is what makes a remediation command correct: `kubectl set image
    deployment/x` is actively wrong for a StatefulSet. Where the owner chain
    cannot be resolved the kind is reported as unknown rather than guessed.
  - the **workload's real name** from its owner, instead of a regex guess at
    which part of the pod name was a generated suffix.
  - **observed running pods**, per workload and per image. During a rollout a
    Deployment running two images is reported as exactly that, so "is the fix
    deployed?" has an honest answer while it is still half-finished.
  - the **Helm release and chart** a workload belongs to, from labels and
    annotations the agent already collects — so StackRadar can group by chart
    alongside namespace and image.
  - an **init-container flag**, so images that run but do not serve traffic can
    be ranked differently.

  Still no new RBAC: all of it comes from the pod informer the agent already
  runs.

  Requires a control plane that accepts inventory v2. Against an older one the
  report is rejected and logged once per interval — **SBOM upload is
  unaffected**, so an agent ahead of its control plane keeps finding
  vulnerabilities while the inventory waits.

### Removed

- Pod labels and annotations are no longer sent with the SBOM. They are facts
  about a deployment, not about an image, and an SBOM carrying your release
  names cannot be shared the way a public image's SBOM can. The same
  breadcrumbs now ride the inventory report instead, where they belong.

## [0.1.3] - 2026-08-14

### Added

- Workload inventory reporting. Within seconds of starting, the agent now tells
  StackRadar every workload it can see — namespace, name, container and image
  reference — before it has pulled or scanned any of them. It repeats the report
  on the heartbeat interval (`HEARTBEAT_INTERVAL_MS`, 5 minutes by default), and
  each report is the complete picture, so a workload you scale to zero leaves
  the list on the next one.

  This is what turns the first few minutes after `helm install` from a blank
  dashboard into "47 workloads discovered, 6 scanned, 41 generating SBOMs".
  Nothing is scanned to produce it, no new RBAC is needed — it comes from the
  same pod informer the agent already runs — and a control plane too old to
  accept the report is not an error: the agent notices the 404 and carries on
  scanning.

  The same report is also what lets StackRadar tell you *which* of your
  workloads it has no SBOM for. The cluster page gains a Coverage panel listing
  them by namespace, workload and image, and anything still unscanned after 30
  minutes is called out as stuck rather than left sitting under "generating
  SBOMs" — that is longer than an image pull and a syft run should take. This
  is where a private registry the agent cannot authenticate to, an image pull
  backoff, or a scan that ran out of memory becomes visible, named image by
  image, instead of quietly showing up as a workload count that is a few short.
  Nothing to configure on the agent; it follows from the report it already
  sends.

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

[Unreleased]: https://github.com/lockdep/stackradar-scanner/compare/v0.1.8...HEAD
[0.1.8]: https://github.com/lockdep/stackradar-scanner/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/lockdep/stackradar-scanner/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/lockdep/stackradar-scanner/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/lockdep/stackradar-scanner/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/lockdep/stackradar-scanner/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/lockdep/stackradar-scanner/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/lockdep/stackradar-scanner/compare/v0.1.1...v0.1.2
[0.1.0]: https://github.com/lockdep/stackradar-scanner/releases/tag/v0.1.0
