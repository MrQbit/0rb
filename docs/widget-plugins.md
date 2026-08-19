# Custom widget plugins

Add a new widget type **without recompiling or re-shipping anything**. There
are three ways to get one installed — all three produce the same thing, a
plugin folder the console hot-loads:

1. **Drop a folder in** — put it in the widgets directory yourself.
2. **Settings → Apps → "Add your own"** — paste the pieces into the console's
   installer.
3. **Ask the agent** — the `CreateWidget` tool lets the agent mint a new
   widget type at runtime when no built-in type fits the data.

## Where plugins live

- **Spark / self-hosted:** `<workspace>/.widgets/` (the
  `ORB2_API_WORKSPACE_ROOT` volume; `/workspace/.widgets` by default).
- **Desktop install:** under the app's user-data folder.
- Override anywhere with `ORB2_WIDGETS_DIR`.

## The contract

A plugin is a folder with two files:

```
<widgetsDir>/my-widget/
  manifest.json
  render.js
```

### `manifest.json`

```json
{
  "type": "stockticker",
  "name": "Stock ticker",
  "description": "Live price for a symbol",
  "icon": "📈",
  "width": 320,
  "height": 200,
  "category": "Custom"
}
```

- `type` — the Widget `type` the agent emits (defaults to the folder name).
- `name`, `description`, `icon`, `category` — how it appears in Settings → Apps.
- `width` / `height` — the card's initial size in px (optional).

### `render.js`

An ES module exporting `render(el, spec, api)` (default or named export):

```js
export function render(el, spec, api) {
  // el   — the card's body element (a flex column). Build DOM inside it.
  // spec — the exact JSON emitted with the Widget tool
  //        ({type, title, ...your custom fields}).
  // api  — helpers; api.esc(s) HTML-escapes a string.
  el.innerHTML = `<div style="padding:14px">${api.esc(spec.symbol || '—')}</div>`
}
```

Rules:

- **Escape everything you interpolate** with `api.esc()` — spec fields are
  data, not markup.
- **Self-contained only** — no external scripts, no network fetches.
- **Style with the console's CSS variables** so the card matches the design
  system in both themes:
  - `var(--ink)` — text
  - `var(--ink-dim)` — muted text
  - `var(--nv)` — the green accent
  - `var(--line)` — hairline borders
  - `var(--mono)` — monospace font

## How it loads

The orb fetches `GET /v1/widgets/plugins` on boot, registers each `type`, and
when that type is emitted it dynamic-imports
`/v1/widgets/plugins/<id>/render.js` and calls `render()`. The agent is told
which custom types exist, so it can use them on its own. Newly installed
plugins are picked up without a restart.

## Path 2: Settings → Apps installer

Settings → **Apps** → **Add your own** takes an id, name, icon, and the
`render.js` source, and writes the plugin folder for you (same API the agent
uses). Plugins appear in the Apps grid alongside built-ins, with the same
on/off toggles, and can be removed from there.

## Path 3: the agent's CreateWidget tool

When no existing widget type fits, the agent can create one itself:

1. `CreateWidget op:'template'` — returns the exact contract above plus a
   starter `render.js` to adapt.
2. `CreateWidget op:'install' {id, name, icon, render_js}` — writes the
   plugin; the console hot-loads it.
3. `Widget {type:'<id>', title:'…', ...fields}` — displays data with it.
   Every field in the Widget spec reaches `render.js` as `spec`.

`op:'list'` shows installed custom widgets; `op:'remove' {id}` deletes one.

Installs are validated: ids must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and
`render.js` is capped at 512 KB.

## Trust model

`render.js` runs in the orb page, exactly like the built-in renderers. Every
install path requires either filesystem access to the box or an authenticated
session — on a single-user box that's the owner's own code. There is
deliberately **no "install from a URL" path**; don't add one without
sandboxing (iframe) first.
