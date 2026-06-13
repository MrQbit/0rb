# Headless Blender service — runs agent-authored bpy scripts and exports glTF.
# No account/API needed; Blender is a local CLI scripted in Python.
FROM debian:trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      blender python3 python3-numpy \
      libgl1 libglu1-mesa libxi6 libxrender1 libxxf86vm1 libxfixes3 libxkbcommon0 libsm6 \
    && rm -rf /var/lib/apt/lists/*

COPY server.py /app/server.py
WORKDIR /app
EXPOSE 8996
CMD ["python3", "/app/server.py"]
