#!/usr/bin/env bash
# Publish the orb2 console for secure remote access via Tailscale.
#
# Tailscale gives the box a stable private address on your tailnet AND
# automatic HTTPS (via `tailscale serve`) — which remote VOICE needs, since
# the browser mic (getUserMedia) only works in a secure context. orb2's
# own username/password still gates everything behind it.
#
# Usage:
#   bash scripts/setup-tailscale.sh                 # tailnet-only (private)
#   bash scripts/setup-tailscale.sh --authkey=tskey-auth-...   # non-interactive
#   bash scripts/setup-tailscale.sh --funnel        # ALSO expose publicly
#
# Run on the Spark host (needs sudo). Re-runnable.
set -euo pipefail

UI_PORT="${ORB2_UI_PORT:-9080}"
AUTH_KEY=""
FUNNEL=false
for arg in "$@"; do
  case "$arg" in
    --authkey=*) AUTH_KEY="${arg#*=}" ;;
    --funnel)    FUNNEL=true ;;
  esac
done

echo "=== orb2 Tailscale publish (UI port ${UI_PORT}) ==="

if ! command -v tailscale &>/dev/null; then
  echo "→ Installing Tailscale..."
  curl -fsSL https://tailscale.com/install.sh | sh
else
  echo "✓ Tailscale installed: $(tailscale version | head -1)"
fi

if ! tailscale status &>/dev/null; then
  if [ -n "$AUTH_KEY" ]; then
    echo "→ Authenticating with auth key..."
    sudo tailscale up --authkey "$AUTH_KEY"
  else
    echo "→ Authenticating interactively (opens a browser / prints a URL)..."
    sudo tailscale up
  fi
else
  echo "✓ Already authenticated."
fi

# Proxy the UI over HTTPS within the tailnet (MagicDNS cert is automatic).
echo "→ Serving the console over HTTPS (tailscale serve)..."
sudo tailscale serve --bg --https=443 "http://127.0.0.1:${UI_PORT}" || \
  sudo tailscale serve --bg "http://127.0.0.1:${UI_PORT}"

if [ "$FUNNEL" = true ]; then
  echo "→ Exposing PUBLICLY via Tailscale Funnel..."
  sudo tailscale funnel --bg 443 on || sudo tailscale funnel --bg "http://127.0.0.1:${UI_PORT}"
fi

HOST_FQDN="$(tailscale status --json 2>/dev/null | grep -oE '"DNSName":[[:space:]]*"[^"]+"' | head -1 | sed 's/.*"\(.*\)\."/\1/' || true)"
TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"

echo ""
echo "✓ Done. orb2 console reachable at:"
[ -n "$HOST_FQDN" ] && echo "    https://${HOST_FQDN}/        (HTTPS — use this for remote voice + iOS)"
[ -n "$TS_IP" ]      && echo "    http://${TS_IP}:${UI_PORT}/   (tailnet IP, no HTTPS)"
echo ""
echo "  orb2 auth is on — sign in with your console credentials."
echo "  For HTTPS, set ORB2_AUTH_COOKIE_SECURE=1 in .env, then:"
echo "    ./scripts/orb2-stack.sh up"
[ "$FUNNEL" = true ] && echo "  ⚠ Funnel exposes this to the public internet (still behind orb2 auth)."
