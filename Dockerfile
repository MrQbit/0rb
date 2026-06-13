FROM nginxinc/nginx-unprivileged:alpine3.22-slim

COPY public/ /usr/share/nginx/html/

# Copy nginx configuration
COPY config/nginx.conf /etc/nginx/conf.d/default.conf

# Make entrypoint executable and set ownership
USER root
RUN adduser -u 10000 default -G root --disabled-password && \
    chown -R 10000:0 /usr/share/nginx && \
    chown -R 10000:0 /etc/nginx

USER 10000
