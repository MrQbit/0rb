#!/usr/bin/env bash
# Start the PersonaPlex (Moshi) voice server on port 8998.
set -euo pipefail

VOICE_PROMPT="${RAK00N_VOICE_VOICE_PROMPT:-NATM0.pt}"
TEXT_PROMPT="${RAK00N_VOICE_PERSONA_PROMPT:-You are rak00n, an AI coding agent. Be concise, technical, and helpful.}"
PORT=8998
SSL_DIR="/etc/rakoon/ssl"

echo "=== Starting PersonaPlex (Moshi) on port ${PORT} ==="

# Generate self-signed cert if not present (Moshi requires HTTPS)
if [ ! -f "${SSL_DIR}/cert.pem" ]; then
  echo "→ Generating self-signed SSL cert..."
  mkdir -p "${SSL_DIR}"
  openssl req -x509 -newkey rsa:4096 -keyout "${SSL_DIR}/key.pem" \
    -out "${SSL_DIR}/cert.pem" -days 365 -nodes \
    -subj "/CN=localhost" 2>/dev/null
fi

exec python3 -m moshi.server \
  --ssl "${SSL_DIR}" \
  --voice-prompt "${VOICE_PROMPT}" \
  --text-prompt "${TEXT_PROMPT}" \
  --port "${PORT}"
