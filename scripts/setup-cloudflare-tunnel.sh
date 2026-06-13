#!/usr/bin/env bash
# Install cloudflared and create a named tunnel for rak00n.
# Usage: bash scripts/setup-cloudflare-tunnel.sh [--domain rakoon.yourdomain.com]
set -euo pipefail

DOMAIN="${1#--domain=}"
DOMAIN="${DOMAIN:-}"

echo "=== rak00n Cloudflare Tunnel Setup ==="

# Install cloudflared
if ! command -v cloudflared &>/dev/null; then
  echo "→ Installing cloudflared..."
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | \
    gpg --dearmor -o /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -q && apt-get install -y cloudflared
else
  echo "✓ cloudflared already installed: $(cloudflared --version)"
fi

# Login (opens browser)
echo ""
echo "→ Authenticating with Cloudflare (opens browser)..."
cloudflared tunnel login

# Create the tunnel
TUNNEL_NAME="rakoon"
echo "→ Creating tunnel '$TUNNEL_NAME'..."
cloudflared tunnel create "$TUNNEL_NAME" || echo "Tunnel may already exist, continuing..."

# Get the tunnel ID
TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
echo "  Tunnel ID: $TUNNEL_ID"

# Write config
mkdir -p config
cat > config/cloudflare-tunnel.yml <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${HOME}/.cloudflared/${TUNNEL_ID}.json

ingress:
EOF

if [ -n "$DOMAIN" ]; then
  cat >> config/cloudflare-tunnel.yml <<EOF
  - hostname: ${DOMAIN}
    service: http://localhost:9081
  - hostname: api.${DOMAIN}
    service: http://localhost:9080
EOF
  echo "  → Creating DNS routes..."
  cloudflared tunnel route dns "$TUNNEL_NAME" "$DOMAIN" || true
  cloudflared tunnel route dns "$TUNNEL_NAME" "api.$DOMAIN" || true
fi

cat >> config/cloudflare-tunnel.yml <<EOF
  - service: http_status:404
EOF

echo ""
echo "✓ Tunnel config written to config/cloudflare-tunnel.yml"

# Install systemd service
if command -v systemctl &>/dev/null; then
  cat > /etc/systemd/system/rakoon-tunnel.service <<UNIT
[Unit]
Description=rak00n Cloudflare Tunnel
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/cloudflared tunnel run --config /opt/rakoon/config/cloudflare-tunnel.yml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  echo "✓ Systemd service installed: rakoon-tunnel.service"
  echo "  Run: systemctl enable --now rakoon-tunnel"
fi

echo ""
echo "=== Done ==="
echo "  Start tunnel: make tunnel-start"
echo "  Status:       cloudflared tunnel info $TUNNEL_NAME"
