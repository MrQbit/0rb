#!/bin/sh
# orb2 self-healing watchdog.
#
# Docker's restart policy only reacts to a container EXITING — it does
# nothing when a container is up but its healthcheck is failing (e.g. vLLM
# wedged, the API hung, nginx not serving). This watchdog closes that gap:
# it polls every container's health, restarts anything unhealthy or exited,
# applies light troubleshooting, and backs off so it never restart-loops a
# genuinely broken service into the ground.
#
# Runs as the `watchdog` compose service (docker:cli + mounted socket), so
# it comes up and recovers with the rest of the stack.
set -eu

# Containers to supervise (compose container_names). The watchdog never
# supervises itself.
SERVICES="${WATCHDOG_SERVICES:-vllm orb2-tts orb2-stt orb2-embed orb2-av-webrtc orb2-redis orb2-api orb2-ui}"
INTERVAL="${WATCHDOG_INTERVAL:-30}"
# Consecutive unhealthy polls before acting (avoids flapping on slow loads).
FAIL_THRESHOLD="${WATCHDOG_FAIL_THRESHOLD:-2}"
# Max restarts per service inside the cooldown window before we stop trying
# and just keep loudly logging (so a hard-broken service is visible, not
# hammered).
MAX_RESTARTS="${WATCHDOG_MAX_RESTARTS:-5}"
COOLDOWN="${WATCHDOG_COOLDOWN:-1800}"   # 30 min window for the restart budget
LOG_FILE="${WATCHDOG_LOG:-/var/log/orb2/watchdog.log}"

mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true

log() {
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  echo "$line"
  echo "$line" >>"$LOG_FILE" 2>/dev/null || true
}

# State directories: consecutive-fail counters and restart timestamps.
STATE=/tmp/orb2-watchdog
mkdir -p "$STATE"

fails() { cat "$STATE/$1.fails" 2>/dev/null || echo 0; }
set_fails() { echo "$2" >"$STATE/$1.fails"; }

# Count restarts within the cooldown window (timestamps, one per line).
recent_restarts() {
  f="$STATE/$1.restarts"
  [ -f "$f" ] || { echo 0; return; }
  now=$(date +%s); cutoff=$((now - COOLDOWN)); n=0
  : >"$f.tmp"
  while read -r ts; do
    [ "$ts" -ge "$cutoff" ] 2>/dev/null && { echo "$ts" >>"$f.tmp"; n=$((n+1)); }
  done <"$f"
  mv "$f.tmp" "$f"
  echo "$n"
}
record_restart() { echo "$(date +%s)" >>"$STATE/$1.restarts"; }

# Light, service-specific troubleshooting hints captured into the log so a
# human (or orb2 itself) can see WHY something fell over.
troubleshoot() {
  c="$1"
  log "  ↳ last logs for $c:"
  docker logs --tail 8 "$c" 2>&1 | sed 's/^/    /' | tail -8 | while read -r l; do log "$l"; done || true
  case "$c" in
    vllm)
      mem=$(free -m 2>/dev/null | awk 'NR==2{print $7"MB avail / "$2"MB"}') || mem="?"
      log "  ↳ host mem: ${mem}; vLLM OOM/CUDA errors are usually memory pressure (stop personaplex, lower --gpu-memory-utilization)"
      ;;
  esac
}

heal() {
  c="$1"; reason="$2"
  budget=$(recent_restarts "$c")
  if [ "$budget" -ge "$MAX_RESTARTS" ]; then
    log "!! $c $reason — restart budget exhausted ($budget/$MAX_RESTARTS in ${COOLDOWN}s); NOT restarting, needs attention"
    troubleshoot "$c"
    return
  fi
  log "** $c $reason — restarting (#$((budget+1)) in window)"
  troubleshoot "$c"
  if docker restart "$c" >/dev/null 2>&1; then
    record_restart "$c"; log "   restarted $c"
  else
    log "   docker restart $c FAILED; trying start"
    docker start "$c" >/dev/null 2>&1 && { record_restart "$c"; log "   started $c"; } || log "   start $c FAILED"
  fi
  set_fails "$c" 0
}

log "watchdog up — supervising: $SERVICES (every ${INTERVAL}s, threshold ${FAIL_THRESHOLD})"
while true; do
  for c in $SERVICES; do
    running=$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo missing)
    if [ "$running" = "missing" ]; then
      log "?? $c not found (compose up may be needed)"; continue
    fi
    if [ "$running" != "true" ]; then
      heal "$c" "is not running"; continue
    fi
    # Health may be 'healthy' | 'unhealthy' | 'starting' | '' (no healthcheck)
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null || echo none)
    if [ "$health" = "unhealthy" ]; then
      n=$(( $(fails "$c") + 1 )); set_fails "$c" "$n"
      log "~~ $c unhealthy ($n/${FAIL_THRESHOLD})"
      [ "$n" -ge "$FAIL_THRESHOLD" ] && heal "$c" "failed $n health checks"
    else
      [ "$(fails "$c")" != "0" ] && log "++ $c recovered ($health)"
      set_fails "$c" 0
    fi
  done
  sleep "$INTERVAL"
done
