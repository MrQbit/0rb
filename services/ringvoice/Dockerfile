FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg wget unzip && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir vosk websocket-client paho-mqtt
# small English model (~40MB) — same family the Android wake word uses
RUN wget -q https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip -O /tmp/m.zip \
  && unzip -q /tmp/m.zip -d /tmp && mv /tmp/vosk-model-small-en-us-0.15 /model && rm /tmp/m.zip
COPY bridge.py /app/bridge.py
CMD ["python", "/app/bridge.py"]
