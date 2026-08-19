# LAN bridge — mDNS discovery + direct AirPlay playback + direct IPP printing.
# Runs with host networking (multicast doesn't cross Docker's bridge), which
# also lets it advertise the console itself (_orb2._tcp) for app auto-discovery.
FROM python:3.12

RUN pip install --no-cache-dir "pyatv>=0.16,<0.17" "zeroconf>=0.132" "aiohttp>=3.9"

WORKDIR /app
COPY server.py .

ENV ORB2_BRIDGE_PORT=8997
HEALTHCHECK --interval=20s --timeout=5s --retries=5 \
  CMD python -c "import urllib.request,os,sys; sys.exit(0 if urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"ORB2_BRIDGE_PORT\",\"8997\")}/health',timeout=3).status==200 else 1)"

CMD ["python", "server.py"]
