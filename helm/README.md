# stackradar-scanner

![Version: 0.1.0](https://img.shields.io/badge/Version-0.1.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 0.1.0](https://img.shields.io/badge/AppVersion-0.1.0-informational?style=flat-square)

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
- Helm 3.10+
- A StackRadar account and API key ([sign up](https://stackradar.io))

## Installing the Chart

```bash
helm install stackradar-scanner oci://ghcr.io/lockdep/charts/stackradar-scanner \
  --namespace stackradar --create-namespace
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
  --namespace stackradar --create-namespace \
  --set stackradar.clusterId=<your-cluster-id> \
  --set stackradar.apiKey=<your-api-key>
```

## Using an existing Secret

```bash
helm install stackradar-scanner oci://ghcr.io/lockdep/charts/stackradar-scanner \
  --namespace stackradar \
  --set stackradar.existingSecret=my-secret
```

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| affinity | object | `{}` | Affinity rules for fine-grained pod placement. |
| dockerConfigSecret | string | `""` | Name of a `kubernetes.io/dockerconfigjson` Secret to mount as a docker config, allowing syft to pull from private registries. Create with: `kubectl create secret generic registry-credentials --from-file=.dockerconfigjson=...` |
| image.pullPolicy | string | `"Always"` | Image pull policy. |
| image.repository | string | `"ghcr.io/lockdep/stackradar-scanner"` | Container image repository. |
| image.tag | string | `""` | Image tag. Defaults to the chart appVersion when not set. |
| imagePullSecrets | list | `[]` | List of image pull secrets for the scanner pod. |
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
| tolerations | list | `[]` | Tolerations for pod scheduling on tainted nodes. |
| watcher.concurrentScans | string | `"1"` | Maximum number of concurrent syft scans. Each invocation can use 300–600 MiB for large images; keeping this at 1 avoids OOM kills. |
| watcher.enabled | bool | `true` | Enable the event-driven watcher with periodic sweeps. |
| watcher.resources | object | `{"limits":{"cpu":"2000m","memory":"1Gi"},"requests":{"cpu":"50m","memory":"512Mi"}}` | Resource requests and limits for the watcher Deployment. |
| watcher.sweepIntervalMs | string | `"21600000"` | How often to run a full pod sweep in milliseconds. Set to 0 to disable periodic sweeps and rely solely on the informer. |
