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

## Choosing what gets scanned

By default every namespace is scanned except `kube-system`, `kube-public` and
`kube-node-lease`. `scanner.includeNamespaces` turns that around into an
allowlist: set it and only the namespaces you name are scanned, `excludeNamespaces`
included.

Namespaces are a coarse tool for the images people most want to skip, though —
`registry.k8s.io/pause` is on every pod in every namespace, and injected sidecars
are cluster-wide by design. `scanner.excludeImages` is the per-image version:

```bash
helm install stackradar-scanner oci://ghcr.io/lockdep/charts/stackradar-scanner \
  --version <version> \
  --namespace stackradar \
  --set stackradar.existingSecret=my-secret \
  --set 'scanner.excludeImages=registry.k8s.io/*\,*/pause\,ghcr.io/acme/vendor-*'
```

An image matching any pattern is never scanned — no syft run, no upload, and no
row in your dashboard. The rules:

- Patterns match the image name with its `:tag` and `@sha256:...` stripped, so
  one pattern keeps working as the tag moves.
- `*` is the only wildcard, and it spans `/` — `registry.k8s.io/*` covers
  `registry.k8s.io/sig-storage/csi-provisioner` too.
- Everything else is literal, and a pattern must match the whole name.
  `registry.k8s.io/*` does not match `myregistry.io/registry.k8s.io-mirror/app`.
- A pattern carrying a tag or a digest could never match, so the agent drops it
  and logs a warning naming it, rather than leaving you with a pattern that
  quietly does nothing.
- Names are matched as your pod spec writes them. A pod running plain `nginx`
  is matched by `nginx`, not by `docker.io/library/*` — nothing here expands the
  implicit Docker Hub prefix.

Escaping the commas is not optional: an unescaped one makes `--set` read the
rest as a second key, and the pattern after it is silently lost. In a values
file the value is one ordinary string and no escaping is needed.

The agent logs the patterns it ended up with on startup, next to the rest of its
configuration. Worth reading after a change — an over-broad pattern removes
coverage without any other signal that it did:

```bash
kubectl logs -n stackradar deploy/stackradar-scanner-watcher | head -1
```

Skipped images are logged individually at `debug` (`LOG_LEVEL=debug`), which is
how you confirm a pattern is hitting what you meant it to.

## Behind a corporate proxy

In a cluster with no direct internet egress, point the agent at your proxy:

```bash
helm install stackradar-scanner oci://ghcr.io/lockdep/charts/stackradar-scanner \
  --version <version> \
  --namespace stackradar --create-namespace \
  --set stackradar.existingSecret=my-secret \
  --set proxy.httpsProxy=http://proxy.corp:8080 \
  --set proxy.noProxy=registry.internal
```

Include the scheme — `proxy.corp:8080` is rejected at install time rather than
half-working later.

This sets `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` on the pod, in both cases,
and the agent installs a proxy dispatcher for its own HTTP client at startup.
That second part is not optional: Node's built-in `fetch` ignores the
conventional environment variables, so a chart that only set them would fix
Syft's registry pulls and leave every call to the StackRadar API failing. The
startup log names the proxy in use, with any `user:pass@` redacted.

`kubernetes.default.svc`, `.svc`, `.cluster.local`, `localhost` and `127.0.0.1`
are always appended to `NO_PROXY`, so Kubernetes API traffic stays inside the
cluster. Add your internal registries to `proxy.noProxy` so image pulls do too.

Leaving both URLs empty renders no environment variables at all, which is what
every install that does not need a proxy gets.

If your proxy terminates TLS — most do — the agent also needs to trust its CA.
See the next section.

## Behind a TLS-intercepting proxy

An egress proxy that terminates and re-signs TLS presents a certificate from
your own CA. Nothing in the pod trusts it yet, so the agent fails with
`unable to verify the first certificate` or
`self-signed certificate in certificate chain`. Give it the CA:

```bash
kubectl create configmap stackradar-ca \
  --namespace stackradar \
  --from-file=ca-certificates.crt=/path/to/your-ca.crt

helm upgrade stackradar-scanner oci://ghcr.io/lockdep/charts/stackradar-scanner \
  --version <version> \
  --namespace stackradar --reuse-values \
  --set caBundle.configMapName=stackradar-ca
```

The file may hold one PEM certificate or several concatenated — an intermediate
plus its root, say. Name it whatever you like and point `caBundle.key` at it;
`ca-certificates.crt` is only the default. If your tooling delivers certificates
as Secrets, `caBundle.secretName` takes one instead. Setting both fails the
install rather than quietly picking one.

**Your CA is added to the public roots, not substituted for them.** The bundle
is mounted read-only at `/etc/ssl/stackradar/` and the pod gets
`NODE_EXTRA_CA_CERTS` (Node — the agent's own API and Kubernetes traffic) and
`SSL_CERT_DIR` (Go — syft's registry pulls). Both extend the trust store the
image already has, so a cluster that pulls some images through the intercepting
proxy and others straight from a public registry keeps working. That is why the
chart does not set `SSL_CERT_FILE`: it *replaces* Go's roots instead of adding
to them, and syft would lose every public registry the moment you mounted a CA.
Concatenating the system bundle into your own is therefore unnecessary.

The certificate has to arrive as a mount. The pod runs with a read-only root
filesystem, so nothing can write into `/etc/ssl/certs` at runtime, and an init
container running `update-ca-certificates` has nowhere to put the result.

Leave both names empty — the default — and no volume and no environment
variables are rendered at all.

## Pulling from your cloud's own registry

To read a private image the scanner needs credentials for the registry it lives
in. On a managed cluster the modern way to get them is workload identity: you
bind the scanner's ServiceAccount to a cloud identity, the cloud injects
short-lived credentials into the pod, and nothing static is ever stored in the
cluster. The alternative — `dockerConfigSecret` — means minting a long-lived
credential and, on ECR, refreshing a 12-hour token with a CronJob you write
yourself.

The chart exposes the three knobs every mechanism is wired up through:

| Value | Used by |
|---|---|
| `serviceAccount.annotations` | EKS IRSA, GKE Workload Identity |
| `podLabels` | Azure Workload Identity |
| `podAnnotations` | Azure Workload Identity |

Create the cloud-side identity and grant it read access to your registry
following your cloud vendor's documentation — the exact IAM shape changes often
enough that repeating it here would only mislead you — then point the chart at
it.

**EKS** — [IAM roles for service accounts](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html):

```bash
helm upgrade stackradar-scanner oci://ghcr.io/lockdep/charts/stackradar-scanner \
  --version <version> \
  --namespace stackradar --reuse-values \
  --set-string 'serviceAccount.annotations.eks\.amazonaws\.com/role-arn=arn:aws:iam::<account>:role/<role>'
```

**GKE** — [Workload Identity Federation](https://cloud.google.com/kubernetes-engine/docs/how-to/workload-identity):

```bash
helm upgrade stackradar-scanner oci://ghcr.io/lockdep/charts/stackradar-scanner \
  --version <version> \
  --namespace stackradar --reuse-values \
  --set-string 'serviceAccount.annotations.iam\.gke\.io/gcp-service-account=<name>@<project>.iam.gserviceaccount.com'
```

**AKS** — [Azure Workload Identity](https://azure.github.io/azure-workload-identity/docs/), which
reads a label on the pod as well as an annotation:

```bash
helm upgrade stackradar-scanner oci://ghcr.io/lockdep/charts/stackradar-scanner \
  --version <version> \
  --namespace stackradar --reuse-values \
  --set-string 'podLabels.azure\.workload\.identity/use=true' \
  --set-string 'podAnnotations.azure\.workload\.identity/client-id=<client-id>' \
  --set-string 'serviceAccount.annotations.azure\.workload\.identity/client-id=<client-id>'
```

`--set-string` in every example above, and it matters for the Azure one:
`azure.workload.identity/use` is the *string* `"true"`, and a plain `--set`
turns it into a boolean that the chart rejects at install time.

**Not yet verified end to end.** These render the annotations and labels the
three mechanisms document, and the credentials the cloud injects reach the
scanner's environment. What has not been confirmed on a real cluster of each
kind is the last step — whether syft's registry client picks those credentials
up on its own. It reads a docker config and the credential helpers named in it,
and the image ships no cloud credential helper binaries, so it is possible that
one or more of the three needs help we have not built yet. If a pull still fails
after you have wired the identity up and confirmed the cloud side is right, that
is worth [telling us](https://github.com/lockdep/stackradar-scanner/issues) —
`dockerConfigSecret` remains the fallback that is known to work everywhere. This
note goes away per cloud as each one is verified.

Annotating a ServiceAccount the chart does not create does nothing, so
`serviceAccount.annotations` together with `serviceAccount.create: false` fails
the install rather than leaving you with a pod that has no credentials and no
explanation. Annotate your own ServiceAccount yourself in that case.

`podLabels` are merged into the pod template's labels, and the chart's own
labels win a collision: `app.kubernetes.io/name`, `app.kubernetes.io/instance`
and `app.kubernetes.io/component` are part of the Deployment's selector, which
Kubernetes will not let you change after the Deployment exists. An entry that
displaced one would install cleanly and break your next upgrade, so it is
dropped instead.

## Health probes

The watcher answers a liveness probe on `/healthz` and a readiness probe on
`/readyz`, over HTTP on port `8081` — named `health`, and moved with
`watcher.healthPort` if something else in the pod's network namespace wants that
number. There is no Service: the kubelet reaches the port on the pod IP, and
nothing else should.

`/healthz` reports what the agent is actually doing. It goes non-2xx when the
watch on the Kubernetes API has been down for three failed restart attempts, or
after five consecutive heartbeat failures, and the kubelet restarts the pod
after three failures a minute apart — so a fault has to persist for around
three minutes before anything happens, which a rolling API server or a
half-minute network blip does not.

A quiet cluster is not a fault. Event recency is deliberately not part of the
signal, so a cluster whose workloads have not changed all night stays healthy.

`/readyz` reports not-ready until the informer's first sync completes. In a
large cluster that initial list takes a while, and until it returns the agent
has not seen the pods it is there to scan — so `helm upgrade --wait` and
`kubectl rollout status` wait for it rather than reporting a rollout that has
not finished.

Both endpoints return the agent's state as JSON, which is worth reading when a
pod is restarting and you want to know why:

```bash
kubectl exec -n stackradar deploy/stackradar-scanner-watcher -- \
  wget -qO- http://127.0.0.1:8081/healthz
```

**If you run default-deny NetworkPolicies**, allow ingress to the `health` port
from the kubelet. A blocked probe is indistinguishable from a dead agent, and
the pod will restart in a loop. `networkPolicy.enabled=true` writes a policy
that already does this — see the next section.

## Restricting the agent's network

`networkPolicy.enabled=true` renders a NetworkPolicy for the scanner pod: no
ingress but the kubelet's health probes, and egress only to DNS, the Kubernetes
API server, and TCP 443. It is off by default, so nothing changes until you ask
for it.

The point is less about blocking traffic than about being checkable. What the
agent talks to is described in prose in the [repository
README](https://github.com/lockdep/stackradar-scanner#what-leaves-your-cluster);
this turns that description into an object you can read with
`kubectl get networkpolicy -n stackradar -o yaml` and hold us to.

### If images stopped being scanned after you enabled it

That is the failure to expect, and it is almost always a registry the egress
rules do not cover — an internal registry on a port other than 443, a pull
through a proxy, or a resolver the DNS rule misses. The agent keeps running and
keeps heartbeating; only the pulls fail.

Confirm it is the policy before changing anything else:

```bash
# What syft actually failed on. Look for connection timeouts rather than 401s —
# a timeout is a policy, a 401 is a credential.
kubectl logs -n stackradar deploy/stackradar-scanner-watcher | grep -i "scan failed"

# Then take the policy away for a minute. If the pulls recover, it was the policy.
helm upgrade stackradar-scanner oci://ghcr.io/lockdep/charts/stackradar-scanner \
  --version <version> \
  --namespace stackradar --reuse-values \
  --set networkPolicy.enabled=false
```

Then put it back with a rule that covers what was missing, using
`networkPolicy.egress` below. Your CNI can usually tell you what it dropped —
`cilium monitor --type drop` on Cilium, or the flow logs your provider exposes.

### A CNI that does not enforce NetworkPolicy ignores this object

The API server accepts a NetworkPolicy whatever your networking is, and
`kubectl get networkpolicy` will show it either way. Plain flannel enforces
nothing; several managed offerings enforce nothing unless network policy was
switched on when the cluster was created. On such a cluster this object is
inert — not a weaker control, no control at all. Confirm your CNI enforces
policy before counting this as one.

### What the default rules allow

Egress, when you leave `networkPolicy.egress` empty:

| Destination | Ports | Why |
|---|---|---|
| Pods in `kube-system` | 53/UDP, 53/TCP | DNS. Everything else here is a name first. |
| Anywhere | 443/TCP, 6443/TCP | The StackRadar API, your registries, and the Kubernetes API server. |
| `169.254.169.254/32` | 80/TCP | Only when workload identity is configured — the token exchange goes through the metadata endpoint. |

Ingress is the `health` port and nothing else, allowed from any source rather
than from the node: probe traffic comes from the kubelet, whose address is not
something a pod selector can name and not something the chart can know. The
endpoint serves the agent's own state to whoever asks, and no Service points at
it.

Two things the defaults do not cover:

- **NodeLocal DNSCache.** Its resolver answers on a link-local address on the
  node, not from a pod in `kube-system`, so the DNS rule above misses it. Add an
  `ipBlock` for `169.254.20.10/32` on port 53 if you run it.
- **A registry on a port other than 443**, including a plain-HTTP internal one.

### Narrowing it

`networkPolicy.egress` takes rules in the API's own `spec.egress` shape and
**replaces** the defaults entirely — merging would leave the wide-open 443 rule
sitting under whatever you narrowed it to. So include DNS in your own list, or
nothing resolves:

```yaml
networkPolicy:
  enabled: true
  egress:
    # DNS.
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
    # The Kubernetes API server, on the CIDR your control plane lives in.
    - to:
        - ipBlock:
            cidr: 10.0.0.0/16
      ports:
        - port: 443
          protocol: TCP
        - port: 6443
          protocol: TCP
    # api.stackradar.io and your registries, narrowed to addresses you know.
    - to:
        - ipBlock:
            cidr: 203.0.113.0/24
      ports:
        - port: 443
          protocol: TCP
```

Note the `6443`. The in-cluster API endpoint is a ClusterIP on 443, but most
CNIs evaluate policy after DNAT — by which point the destination is a node on
6443. A rule that allows only 443 reads correctly and cuts the agent off from
the API server, which is why the default allows both.

**Behind a proxy this gets much tighter.** With `proxy.httpsProxy` set, the only
addresses the agent reaches are DNS, the Kubernetes API server, and the proxy —
so an egress list of those three is both the smallest and the most accurate
policy you can write here. Registries and the StackRadar API drop out of it
entirely.

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
| caBundle.configMapName | string | `""` | Name of a ConfigMap holding additional CA certificates to trust, for clusters behind a TLS-intercepting proxy. The object must hold a PEM bundle under `caBundle.key`; it is mounted read-only and added to the trust store of both runtimes in the image. Mutually exclusive with `caBundle.secretName` — setting both fails the render rather than silently picking one. |
| caBundle.key | string | `"ca-certificates.crt"` | Key within the ConfigMap or Secret holding the PEM bundle. Only this one key is mounted, so unrelated keys in the same object are not exposed to the pod. |
| caBundle.secretName | string | `""` | Name of a Secret holding the same thing, for workflows that keep the bundle in a Secret. A CA certificate is public by nature, so a ConfigMap is the usual home; this exists because external-secrets and SOPS pipelines deliver everything as Secrets. |
| dockerConfigSecret | string | `""` | Name of a `kubernetes.io/dockerconfigjson` Secret to mount as a docker config, allowing syft to pull from private registries. Create with: `kubectl create secret generic registry-credentials --from-file=.dockerconfigjson=...` |
| fullnameOverride | string | `""` | Override the full name of the chart's resources, replacing the `<release>-<chart>` default entirely. |
| image.digest | string | `""` | Image digest (sha256:...). Stamped by the release workflow so every published chart pins the exact image bytes it was tested against, and set empty on dev builds. The digest wins over the tag: to run a different image you must clear this as well (`--set image.tag=X --set image.digest=""`), otherwise the tag is cosmetic. |
| image.pullPolicy | string | `"Always"` | Image pull policy. |
| image.repository | string | `"ghcr.io/lockdep/stackradar-scanner"` | Container image repository. |
| image.tag | string | `""` | Image tag. Defaults to the chart appVersion, which for a released chart is the release version — leave empty so the chart and the image it deploys stay in lockstep. |
| imagePullSecrets | list | `[]` | List of image pull secrets for the scanner pod. |
| nameOverride | string | `""` | Override the chart name used in resource names and labels. |
| networkPolicy.egress | list | `[]` | Egress rules, written in the API's own `spec.egress` shape. Left empty, the chart renders defaults covering DNS, the Kubernetes API server, and TCP 443 to any address — the StackRadar API and your registries. A list set here replaces those defaults entirely rather than adding to them: narrow the 443 rule to the CIDRs your registries live in if you know them, and keep a DNS rule of your own or nothing resolves. Behind a proxy this collapses to DNS plus the proxy's address, which is a far tighter policy than the default. |
| networkPolicy.enabled | bool | `false` | Create a NetworkPolicy for the scanner pod. Ingress is denied except the health port the kubelet probes on; egress is allowed to the destinations in `networkPolicy.egress`. Requires a CNI that enforces NetworkPolicy — with one that does not, the object is inert rather than a false sense of safety, so confirm yours enforces policy before treating this as a control. |
| nodeSelector | object | `{}` | Node selector for pod scheduling. |
| podAnnotations | object | `{}` | Extra annotations for the scanner pod, e.g. the client ID Azure Workload Identity reads (`azure.workload.identity/client-id`). |
| podLabels | object | `{}` | Extra labels for the scanner pod. Azure Workload Identity is switched on here, with `azure.workload.identity/use: "true"`. The chart's own labels win on a collision: `app.kubernetes.io/name`, `app.kubernetes.io/instance` and `app.kubernetes.io/component` are part of the Deployment's selector and are immutable after creation, so a value that displaced one would break the next `helm upgrade` rather than this install. |
| podSecurityContext | object | `{"fsGroup":65534,"runAsGroup":65534,"runAsNonRoot":true,"runAsUser":65534}` | Pod-level security context. |
| priorityClassName | string | `""` | PriorityClassName so the scanner yields resources to application pods. |
| proxy.httpProxy | string | `""` | HTTP proxy URL for outbound traffic, e.g. `http://proxy.corp:8080`. Include the scheme — a bare `proxy.corp:8080` is rejected, because tools that read these variables disagree about what a scheme-less value means. |
| proxy.httpsProxy | string | `""` | HTTPS proxy URL for outbound traffic. Set this one if you set only one: the StackRadar API and most registries are reached over https. |
| proxy.noProxy | string | `""` | Comma-separated hosts that bypass the proxy. The in-cluster Kubernetes API (`kubernetes.default.svc`, `.svc`, `.cluster.local`, `localhost`, `127.0.0.1`) is always appended, so list only your own internal registries here. |
| scanner.argocdNamespace | string | `"argocd"` | Namespace holding your ArgoCD `Application` objects. Only used when `scanner.resolveArgocdApplications` is "true".  Also the namespace reported for an app named by a tracking annotation, since Argo's tracking ID names the app but not where it lives. With apps-in-any-namespace enabled the annotation carries `<namespace>/<app>` and that wins over this value. |
| scanner.excludeImages | string | `""` | Comma-separated glob patterns for images that are never scanned, whatever namespace they run in. Matched against the image name with its tag and digest stripped, so a pattern written once keeps working as the tag moves. `*` is the only wildcard and it spans `/`; everything else is literal, and patterns match the whole name — `registry.k8s.io/*` covers `registry.k8s.io/pause:3.9` but not `myregistry.io/registry.k8s.io-mirror/app`. A pattern that carries a `:tag` or an `@sha256:...` could never match, so it is dropped with a warning at startup rather than silently doing nothing. The agent logs the patterns it ended up with when it starts — worth reading, since an over-broad one drops coverage quietly. Example: "registry.k8s.io/*,*/pause,ghcr.io/acme/vendor-*" |
| scanner.excludeNamespaces | string | `"kube-system,kube-public,kube-node-lease"` | Comma-separated list of namespaces to exclude from scanning. |
| scanner.imagePullSecretNames | list | `[]` | Names of the imagePullSecrets the scanner is allowed to read. When empty, the ClusterRole grants `secrets get` cluster-wide. Naming your pull secrets here narrows the grant to those names via RBAC `resourceNames` — the recommended setting. Names match in every namespace: a Secret called `regcred` anywhere in the cluster is readable, so use distinct names if that matters to you. A Secret left off the list is not readable, and images that need it fall back to an anonymous pull — the agent logs a warning naming the Secret. Only used when `scanner.resolveImagePullSecrets` is "true". |
| scanner.includeNamespaces | string | `""` | Comma-separated list of namespaces to scan. When set, ONLY these namespaces are scanned. |
| scanner.resolveArgocdApplications | string | `"true"` | Read ArgoCD `Application` objects for the repository URL, chart and target revision behind a GitOps-delivered workload. Requires `list` on `argoproj.io/applications` in the ClusterRole, which this value gates.  Harmless on a cluster with no ArgoCD: the first list returns 404, which the agent takes as "no CRD" and never asks again. Workloads still get their delivery layer from the `argocd.argoproj.io/tracking-id` annotation without it — they simply carry no repository URL, and a chart upgrade then has no `targetRevision` to point at. |
| scanner.resolveImagePullSecrets | string | `"true"` | Resolve imagePullSecrets from workload pod specs for private registry auth. Requires `secrets get` permission in the ClusterRole, which `scanner.imagePullSecretNames` narrows to a named set of Secrets. |
| scanner.resolveWorkloadOwners | string | `"true"` | Read the metadata of the object each pod belongs to — its Deployment, StatefulSet, DaemonSet, Job or CronJob — to recover the Helm and GitOps context the pod itself does not carry. Requires `get` on `apps` and `batch` in the ClusterRole, which this value gates.  On by default because it fixes wrong data rather than adding capability: Helm writes `meta.helm.sh/release-*` onto the objects it applies and never onto the pod template inside them, and an operator that generates a StatefulSet from a custom resource writes its own labels for the pods it manages — so with pod metadata alone, chart-managed workloads are reported as unmanaged. The agent asks for `PartialObjectMetadata`, so the API server returns labels and annotations and never the workload spec, and only the same allowlist that applies to pod metadata is ever forwarded.  One `get` per distinct controller per process, on the 5-minute inventory path — never on the pod watch. Denied (403) it logs one line and falls back to pod-only attribution rather than failing the report. |
| scanner.skipExistingDigests | string | `"true"` | Skip images whose digest is already indexed in StackRadar. Eliminates redundant syft runs when the image binary has not changed. |
| scanner.syftTimeoutMs | string | `"300000"` | Timeout per image scan in milliseconds. |
| securityContext | object | `{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"readOnlyRootFilesystem":true}` | Container-level security context. |
| serviceAccount.annotations | object | `{}` | Annotations for the ServiceAccount. This is where cloud workload identity is wired up — `eks.amazonaws.com/role-arn` on EKS, `iam.gke.io/gcp-service-account` on GKE — so the pod receives short-lived credentials from the cloud instead of a static `dockerConfigSecret`. Only meaningful with `serviceAccount.create: true`; setting both fails the render rather than putting the annotations nowhere. |
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
| watcher.healthPort | string | `"8081"` | Port for the agent's liveness and readiness endpoints. Not exposed by a Service — the kubelet reaches it on the pod IP and nothing else does. Change it only if something else in the pod's network namespace already listens here. Must be 1024 or above: the container drops every Linux capability, so it cannot bind a privileged port. |
| watcher.resources | object | `{"limits":{"cpu":"2000m","memory":"1Gi"},"requests":{"cpu":"50m","memory":"512Mi"}}` | Resource requests and limits for the watcher Deployment. |
| watcher.sweepIntervalMs | string | `"21600000"` | How often to run a full pod sweep in milliseconds. Set to 0 to disable periodic sweeps and rely solely on the informer. |
