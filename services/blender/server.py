#!/usr/bin/env python3
"""
Headless Blender HTTP service for orb2.

POST /run { "script": "<bpy python>", "out": "/workspace/.../x.glb" }
  → clears the scene, runs the agent's bpy script, exports a .glb to `out`.
  Returns { ok, out, stderr? }. The agent re-sends the FULL scene script each
  turn (it owns the scene description); we rebuild + re-export so the widget
  refreshes with the latest model.

GET /health → { ok: true }
"""
import http.server, socketserver, json, subprocess, tempfile, os

PORT = int(os.environ.get("PORT", "8996"))

PRELUDE = (
    "import bpy, math, mathutils\n"
    "# start from an empty scene each run (the script rebuilds everything)\n"
    "bpy.ops.object.select_all(action='SELECT')\n"
    "bpy.ops.object.delete(use_global=False)\n"
)
EXPORT = (
    "\nimport bpy\n"
    "bpy.ops.export_scene.gltf(filepath=r'{out}', export_format='GLB')\n"
)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/run":
            return self._send(404, {"error": "not found"})
        n = int(self.headers.get("content-length", 0) or 0)
        try:
            data = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._send(400, {"error": "bad json"})
        script = data.get("script", "")
        out = data.get("out", "")
        if not out:
            return self._send(400, {"error": "out required"})
        try:
            os.makedirs(os.path.dirname(out), exist_ok=True)
        except Exception as e:
            return self._send(500, {"error": f"mkdir: {e}"})
        full = PRELUDE + "\n" + script + EXPORT.format(out=out)
        path = None
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
                f.write(full)
                path = f.name
            try:
                os.remove(out)
            except OSError:
                pass
            p = subprocess.run(
                ["blender", "--background", "--factory-startup", "--python", path],
                capture_output=True, text=True, timeout=180,
            )
            ok = os.path.exists(out) and os.path.getsize(out) > 0
            self._send(200 if ok else 500, {
                "ok": ok, "out": out,
                "stderr": "" if ok else (p.stderr or p.stdout)[-1800:],
            })
        except subprocess.TimeoutExpired:
            self._send(500, {"ok": False, "error": "blender timed out"})
        except Exception as e:
            self._send(500, {"ok": False, "error": str(e)})
        finally:
            if path:
                try: os.unlink(path)
                except OSError: pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    print(f"blender service on :{PORT}", flush=True)
    Server(("0.0.0.0", PORT), Handler).serve_forever()
