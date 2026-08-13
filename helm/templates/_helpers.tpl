{{/*
Expand the name of the chart.
*/}}
{{- define "stackradar-scanner.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Full name, capped at 63 chars.
If release name contains the chart name, just use the release name to avoid
duplication (e.g. "stackradar-scanner-stackradar-scanner").
*/}}
{{- define "stackradar-scanner.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else if contains .Chart.Name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/*
Service account name.
*/}}
{{- define "stackradar-scanner.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "stackradar-scanner.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Selector labels (subset used in matchLabels — must be immutable after creation).
*/}}
{{- define "stackradar-scanner.selectorLabels" -}}
app.kubernetes.io/name: {{ include "stackradar-scanner.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "stackradar-scanner.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- include "stackradar-scanner.selectorLabels" . | nindent 0 }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Labels for a pod template: the chart's own, plus `podLabels`.

Takes a dict — `root` is the usual context, `component` the value of
`app.kubernetes.io/component` for this workload.

The two are merged into one map here rather than concatenated as two YAML
blocks, so every key is emitted once and the chart's labels win a collision. The
selector labels — name, instance and component — are all in the Deployment's
`matchLabels`, which is immutable after creation: a `podLabels` entry that
displaced one would not fail this install, it would fail the *next* upgrade,
with an error naming the selector rather than the value that caused it.
`merge`'s first argument wins over the rest, so the order below is the whole
guarantee.
*/}}
{{- define "stackradar-scanner.podLabels" -}}
{{- $root := .root -}}
{{- $chartLabels := fromYaml (include "stackradar-scanner.labels" $root) -}}
{{- toYaml (merge (dict "app.kubernetes.io/component" .component) $chartLabels $root.Values.podLabels) }}
{{- end }}
