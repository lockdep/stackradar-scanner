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
