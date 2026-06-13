# rak00n WhatsApp bridge — Node + Baileys (WhatsApp Web).
FROM node:20-slim

WORKDIR /app

# git + ca-certificates: Baileys pulls libsignal from a git URL.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install deps first for layer caching.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./

ENV PORT=8995 \
    WA_AUTH_DIR=/wa-auth

EXPOSE 8995
# Auth state persists in the mounted /wa-auth volume across restarts.
CMD ["node", "server.js"]
