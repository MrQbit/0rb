/**
 * rak00n canvas pod server.
 *
 * Port 9090 — RPC endpoint for the API server to write files and init templates.
 * Port 5173 — Static file server for the canvas SPA (served via /v1/preview proxy).
 *
 * All templates use CDN-based deps (Chart.js, React via esm.sh, Tailwind) so
 * no build step is required — files are served as-is.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const WORKSPACE = process.env.CANVAS_WORKSPACE || '/workspace';
const RPC_PORT = parseInt(process.env.RPC_PORT || '9090', 10);
const STATIC_PORT = parseInt(process.env.STATIC_PORT || '5173', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.jsx': 'application/javascript; charset=utf-8',
  '.tsx': 'application/javascript; charset=utf-8',
  '.ts': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

// ── RPC server (port 9090) ────────────────────────────────────────────────────

const rpc = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, workspace: WORKSPACE }));
  }

  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body); } catch {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'invalid json' }));
    }

    // POST /write — write one or more files
    if (req.url === '/write') {
      const files = payload.files;  // { [relPath]: content }
      if (!files || typeof files !== 'object') {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'files required' }));
      }
      const written = [];
      for (const [rel, content] of Object.entries(files)) {
        // Security: no path traversal
        const abs = path.resolve(WORKSPACE, rel);
        if (!abs.startsWith(path.resolve(WORKSPACE))) {
          res.writeHead(403);
          return res.end(JSON.stringify({ error: `path escape: ${rel}` }));
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
        written.push(rel);
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, written }));
    }

    // POST /init — scaffold a template
    if (req.url === '/init') {
      const template = payload.template || 'html';
      const files = getTemplateFiles(template);
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.resolve(WORKSPACE, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (!fs.existsSync(abs)) fs.writeFileSync(abs, content, 'utf8');
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, template, entry: 'index.html' }));
    }
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'not found' }));
});

// ── Static file server (port 5173) ───────────────────────────────────────────

const staticSrv = http.createServer((req, res) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Access-Control-Allow-Origin', '*');

  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const abs = path.resolve(WORKSPACE, urlPath.replace(/^\/+/, ''));
  if (!abs.startsWith(path.resolve(WORKSPACE))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  // Try exact path, then index.html fallback for SPA
  let filePath = abs;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(WORKSPACE, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    return res.end('Not found');
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'no-cache');
  res.writeHead(200);
  fs.createReadStream(filePath).pipe(res);
});

// ── Templates ────────────────────────────────────────────────────────────────

function getTemplateFiles(template) {
  switch (template) {
    case 'react': return REACT_FILES;
    case 'vue': return VUE_FILES;
    case 'vanilla-js': return VANILLA_FILES;
    default: return HTML_FILES;
  }
}

const HTML_FILES = {
  'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Canvas</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="./style.css"/>
</head>
<body class="p-6 bg-slate-50 text-slate-900">
  <main id="app">
    <h1 class="text-2xl font-semibold mb-4">Canvas</h1>
    <p class="text-slate-600">Replace with your visualization. Chart.js and Tailwind are pre-loaded.</p>
  </main>
  <script type="module" src="./app.js"></script>
</body></html>`,
  'style.css': `body { font-family: ui-sans-serif, system-ui, sans-serif; }
.card { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; }`,
  'app.js': `// Canvas entrypoint\nconsole.log('Canvas ready');`,
};

const REACT_FILES = {
  'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Canvas (React)</title>
  <link rel="stylesheet" href="./style.css"/>
  <script type="importmap">{"imports":{"react":"https://esm.sh/react@18.3.1","react-dom/client":"https://esm.sh/react-dom@18.3.1/client","chart.js/auto":"https://esm.sh/chart.js@4.4.0/auto"}}</script>
  <script src="https://cdn.tailwindcss.com"></script>
  <script type="module" src="https://esm.sh/tsx@4.19.0/runtime"></script>
</head>
<body class="bg-slate-50 text-slate-900">
  <div id="root"></div>
  <script type="module" src="./main.tsx"></script>
</body></html>`,
  'main.tsx': `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
createRoot(document.getElementById('root')).render(<App />);`,
  'App.tsx': `import React from 'react';
export default function App() {
  return <main className="p-6 max-w-5xl mx-auto">
    <h1 className="text-2xl font-semibold mb-4">Canvas</h1>
    <p className="text-slate-600">Edit App.tsx to build your visualization.</p>
  </main>;
}`,
  'style.css': `body { font-family: ui-sans-serif, system-ui, sans-serif; }`,
};

const VUE_FILES = {
  'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Canvas (Vue)</title>
  <link rel="stylesheet" href="./style.css"/>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 text-slate-900">
  <div id="app"></div>
  <script type="module" src="./main.js"></script>
</body></html>`,
  'main.js': `import { createApp } from 'https://esm.sh/vue@3.5.12/dist/vue.esm-bundler.js';
import App from './App.js';
createApp(App).mount('#app');`,
  'App.js': `import { defineComponent, h } from 'https://esm.sh/vue@3.5.12/dist/vue.esm-bundler.js';
export default defineComponent({
  setup() { return () => h('main', { class: 'p-6' }, [
    h('h1', { class: 'text-2xl font-semibold mb-4' }, 'Canvas'),
    h('p', { class: 'text-slate-600' }, 'Edit App.js to build your visualization.'),
  ]); },
});`,
  'style.css': `body { font-family: ui-sans-serif, system-ui, sans-serif; }`,
};

const VANILLA_FILES = {
  'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Canvas</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="./style.css"/>
</head>
<body class="p-6 bg-slate-50 text-slate-900">
  <main id="app">
    <h1 class="text-2xl font-semibold mb-4">Canvas</h1>
  </main>
  <script type="module" src="./app.js"></script>
</body></html>`,
  'style.css': `body { font-family: ui-sans-serif, system-ui, sans-serif; }`,
  'app.js': `// Entry point\nconsole.log('Canvas ready');`,
};

// ── Start servers ─────────────────────────────────────────────────────────────

fs.mkdirSync(WORKSPACE, { recursive: true });

rpc.listen(RPC_PORT, '0.0.0.0', () => console.log(`[canvas-rpc] listening on :${RPC_PORT}`));
staticSrv.listen(STATIC_PORT, '0.0.0.0', () => console.log(`[canvas-static] serving ${WORKSPACE} on :${STATIC_PORT}`));
