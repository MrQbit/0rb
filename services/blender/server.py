#!/usr/bin/env python3
"""
Headless Blender HTTP service for orb2.

POST /run     { script, out }            bpy script → .glb (the model widget)
POST /render  { script?|in, out, angle? } lit EEVEE still → .png
POST /convert { in, out }                 stl/obj/ply/fbx/glb → glb (or back)
POST /analyze { in }                      dims/volume/tris/watertight (print check)

The agent re-sends the FULL scene script each turn (it owns the scene
description); we rebuild + re-export so the widget refreshes.

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


def run_blender(py: str, timeout=240):
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
        f.write(py)
        path = f.name
    try:
        return subprocess.run(
            ["blender", "--background", "--factory-startup", "--python", path],
            capture_output=True, text=True, timeout=timeout,
        )
    finally:
        try: os.unlink(path)
        except OSError: pass


IMPORTERS = {
    ".stl": "bpy.ops.wm.stl_import(filepath=r'{p}')",
    ".obj": "bpy.ops.wm.obj_import(filepath=r'{p}')",
    ".ply": "bpy.ops.wm.ply_import(filepath=r'{p}')",
    ".fbx": "bpy.ops.import_scene.fbx(filepath=r'{p}')",
    ".glb": "bpy.ops.import_scene.gltf(filepath=r'{p}')",
    ".gltf": "bpy.ops.import_scene.gltf(filepath=r'{p}')",
}
EXPORTERS = {
    ".glb": "bpy.ops.export_scene.gltf(filepath=r'{p}', export_format='GLB')",
    ".stl": "bpy.ops.wm.stl_export(filepath=r'{p}', export_selected_objects=False)",
    ".obj": "bpy.ops.wm.obj_export(filepath=r'{p}')",
    ".fbx": "bpy.ops.export_scene.fbx(filepath=r'{p}')",
}


def import_line(path):
    ext = os.path.splitext(path)[1].lower()
    tpl = IMPORTERS.get(ext)
    return tpl.format(p=path) if tpl else None


def export_line(path):
    ext = os.path.splitext(path)[1].lower()
    tpl = EXPORTERS.get(ext)
    return tpl.format(p=path) if tpl else None


# Studio-ish lighting + camera framing for /render — the agent gets a lit
# still without writing lighting boilerplate.
RENDER_RIG = """
import bpy, math, mathutils
scene = bpy.context.scene
# Cycles on CPU: renders headless with no GL/EGL context at all.
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 48
scene.cycles.use_denoising = False
scene.render.resolution_x = 1024
scene.render.resolution_y = 768
scene.render.film_transparent = False
world = bpy.data.worlds.new('w') if not scene.world else scene.world
scene.world = world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs[0].default_value = (0.04, 0.05, 0.04, 1)
# frame everything
objs = [o for o in scene.objects if o.type == 'MESH']
if objs:
    mins = mathutils.Vector((min(min((o.matrix_world @ mathutils.Vector(c))[i] for c in o.bound_box) for o in objs) for i in range(3)))
    maxs = mathutils.Vector((max(max((o.matrix_world @ mathutils.Vector(c))[i] for c in o.bound_box) for o in objs) for i in range(3)))
    center = (mins + maxs) / 2
    size = max((maxs - mins).length, 0.001)
    ang = math.radians({angle})
    cam_data = bpy.data.cameras.new('cam')
    cam = bpy.data.objects.new('cam', cam_data)
    scene.collection.objects.link(cam)
    cam.location = center + mathutils.Vector((math.cos(ang) * size * 1.6, math.sin(ang) * size * 1.6, size * 0.9))
    d = cam.location - center
    cam.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    scene.camera = cam
    key = bpy.data.objects.new('key', bpy.data.lights.new('key', 'AREA'))
    key.data.energy = 900 * size * size; key.data.size = size * 2
    key.location = center + mathutils.Vector((size, -size, size * 2))
    scene.collection.objects.link(key)
    fill = bpy.data.objects.new('fill', bpy.data.lights.new('fill', 'AREA'))
    fill.data.energy = 300 * size * size; fill.data.size = size * 3
    fill.location = center + mathutils.Vector((-size * 1.5, size, size))
    scene.collection.objects.link(fill)
scene.render.filepath = r'{out}'
bpy.ops.render.render(write_still=True)
"""

ANALYZE = """
import bpy, bmesh, json, mathutils
objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
tris = 0; vol = 0.0; watertight = True
mins = [1e18]*3; maxs = [-1e18]*3
for o in objs:
    m = o.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
    bm = bmesh.new(); bm.from_mesh(m); bmesh.ops.triangulate(bm, faces=bm.faces)
    tris += len(bm.faces)
    bm.transform(o.matrix_world)
    vol += abs(bm.calc_volume(signed=True))
    if any(len(e.link_faces) != 2 for e in bm.edges): watertight = False
    for v in bm.verts:
        for i in range(3):
            mins[i] = min(mins[i], v.co[i]); maxs[i] = max(maxs[i], v.co[i])
    bm.free()
dims = [round(maxs[i]-mins[i], 4) if objs else 0 for i in range(3)]
print('ORB_ANALYZE ' + json.dumps({
    'objects': len(objs), 'triangles': tris,
    'dimensions_m': dims, 'volume_l': round(vol*1000, 4), 'watertight': watertight,
}))
"""


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
        n = int(self.headers.get("content-length", 0) or 0)
        try:
            data = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._send(400, {"error": "bad json"})
        if self.path == "/convert":
            return self._convert(data)
        if self.path == "/analyze":
            return self._analyze(data)
        if self.path == "/render":
            return self._render(data)
        if self.path != "/run":
            return self._send(404, {"error": "not found"})
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

    def _convert(self, data):
        src, out = data.get("in", ""), data.get("out", "")
        imp, exp = import_line(src), export_line(out)
        if not (src and os.path.exists(src)): return self._send(400, {"error": "in file missing"})
        if not imp: return self._send(400, {"error": "unsupported input format"})
        if not exp: return self._send(400, {"error": "unsupported output format"})
        os.makedirs(os.path.dirname(out), exist_ok=True)
        p = run_blender(PRELUDE + "\n" + imp + "\n" + exp)
        ok = os.path.exists(out) and os.path.getsize(out) > 0
        self._send(200 if ok else 500, {"ok": ok, "out": out, "stderr": "" if ok else (p.stderr or p.stdout)[-1200:]})

    def _analyze(self, data):
        src = data.get("in", "")
        imp = import_line(src)
        if not (src and os.path.exists(src)): return self._send(400, {"error": "in file missing"})
        if not imp: return self._send(400, {"error": "unsupported format"})
        p = run_blender(PRELUDE + "\n" + imp + "\n" + ANALYZE)
        for line in (p.stdout or "").splitlines():
            if line.startswith("ORB_ANALYZE "):
                return self._send(200, {"ok": True, **json.loads(line[len("ORB_ANALYZE "):])})
        self._send(500, {"ok": False, "error": (p.stderr or p.stdout)[-1200:]})

    def _render(self, data):
        script, src, out = data.get("script", ""), data.get("in", ""), data.get("out", "")
        angle = float(data.get("angle", 35))
        if not out: return self._send(400, {"error": "out required"})
        build = ""
        if script:
            build = script
        elif src:
            imp = import_line(src)
            if not imp: return self._send(400, {"error": "unsupported format"})
            build = imp
        else:
            return self._send(400, {"error": "script or in required"})
        os.makedirs(os.path.dirname(out), exist_ok=True)
        rig = RENDER_RIG.replace("{angle}", str(angle)).replace("{out}", out)
        p = run_blender(PRELUDE + "\n" + build + "\n" + rig, timeout=300)
        ok = os.path.exists(out) and os.path.getsize(out) > 0
        self._send(200 if ok else 500, {"ok": ok, "out": out, "stderr": "" if ok else (p.stderr or p.stdout)[-1200:]})


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    print(f"blender service on :{PORT}", flush=True)
    Server(("0.0.0.0", PORT), Handler).serve_forever()
