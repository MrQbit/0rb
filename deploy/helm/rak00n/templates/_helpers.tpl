{{- define "rak00n.name" -}}rak00n{{- end -}}

{{- define "rak00n.namespace" -}}
{{ .Values.global.namespace | default "rak00n" }}
{{- end -}}

{{- define "rak00n.labels" -}}
app.kubernetes.io/name: {{ include "rak00n.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "rak00n.selectorLabels" -}}
app.kubernetes.io/name: {{ include "rak00n.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "rak00n.image" -}}
{{ .Values.global.imageRepository }}:{{ .Values.global.imageTag }}
{{- end -}}

{{- define "rak00n.redisUrl" -}}
{{- if .Values.redis.enabled -}}
{{- if .Values.redis.password -}}
redis://:{{ .Values.redis.password }}@rak00n-redis.{{ include "rak00n.namespace" . }}.svc.cluster.local:6379
{{- else -}}
redis://rak00n-redis.{{ include "rak00n.namespace" . }}.svc.cluster.local:6379
{{- end -}}
{{- end -}}
{{- end -}}
