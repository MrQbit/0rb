# Matter bridge — orb's world in Apple Home. Host networking (commissioning
# is mDNS + UDP); state persists in /data so the pairing survives restarts.
FROM node:22-slim

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.mjs .

ENV ORB2_MATTER_STORAGE=/data
HEALTHCHECK --interval=20s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ORB2_MATTER_HTTP_PORT||8998)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
