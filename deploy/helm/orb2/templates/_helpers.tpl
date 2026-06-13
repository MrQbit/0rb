{{- define "orb2.name" -}}orb2{{- end -}}

{{- define "orb2.namespace" -}}
{{ .Values.global.namespace | default "orb2" }}
{{- end -}}

{{- define "orb2.labels" -}}
app.kubernetes.io/name: {{ include "orb2.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "orb2.selectorLabels" -}}
app.kubernetes.io/name: {{ include "orb2.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "orb2.image" -}}
{{ .Values.global.imageRepository }}:{{ .Values.global.imageTag }}
{{- end -}}

{{- define "orb2.redisUrl" -}}
{{- if .Values.redis.enabled -}}
{{- if .Values.redis.password -}}
redis://:{{ .Values.redis.password }}@orb2-redis.{{ include "orb2.namespace" . }}.svc.cluster.local:6379
{{- else -}}
redis://orb2-redis.{{ include "orb2.namespace" . }}.svc.cluster.local:6379
{{- end -}}
{{- end -}}
{{- end -}}
