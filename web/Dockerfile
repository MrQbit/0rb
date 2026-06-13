FROM nginxinc/nginx-unprivileged:alpine3.22-slim

COPY public/ /usr/share/nginx/html/
COPY config/nginx.conf /etc/nginx/conf.d/default.conf

USER root
# Self-signed cert so the LAN gets a secure context (camera/mic/getUserMedia
# only work over HTTPS or on localhost). Browsers warn once on the self-signed
# cert; for a clean cert use Tailscale serve instead.
RUN apk add --no-cache openssl && \
    mkdir -p /etc/nginx/certs && \
    openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
      -keyout /etc/nginx/certs/self.key -out /etc/nginx/certs/self.crt \
      -subj "/CN=rak00n.local" \
      -addext "subjectAltName=DNS:localhost,DNS:rak00n.local,IP:127.0.0.1" && \
    adduser -u 10000 default -G root --disabled-password 2>/dev/null || true && \
    chown -R 10000:0 /usr/share/nginx /etc/nginx && \
    chmod -R g+rX /etc/nginx/certs

USER 10000
EXPOSE 8080 8443
