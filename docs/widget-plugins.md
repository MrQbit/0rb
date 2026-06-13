# Custom widget plugins

Add a new widget **without recompiling or re-shipping anything** — drop a folder
into the widgets directory and it appears in Settings → Apps and renders when a
`Widget` of its `type` is emitted (by you or the agent).

## Where
- **Spark / self-hosted:** `<workspace>/.widgets/` (the `RAK00N_API_WORKSPACE_ROOT`
  volume; `/workspace/.widgets` by default).
- **Desktop install:** under the app's user-data folder.
- Override anywhere with `RAK00N_WIDGETS_DIR`.

## Shape
```
<widgetsDir>/my-widget/
  manifest.json
  render.js
```

`manifest.json`:
```json
{
  "type": "stockticker",        // the Widget `type` the agent emits
  "name": "Stock ticker",
  "description": "Live price for a symbol",
  "icon": "📈",
  "width": 320,
  "height": 200,
  "category": "Custom"
}
```

`render.js` — an ES module exporting `render(el, spec, api)`:
```js
export function render(el, spec, api) {
  // `el`   — the widget body element to fill
  // `spec` — the full Widget spec the agent emitted (your custom data fields)
  // `api`  — small helpers, e.g. api.esc(text) to HTML-escape
  el.innerHTML = `<div style="padding:14px">${api.esc(spec.symbol || '—')}</div>`
}
```

## How it loads
The orb fetches `GET /v1/widgets/plugins` on boot, registers each `type`, and
when that type is emitted it dynamic-imports `/v1/widgets/plugins/<id>/render.js`
and calls `render()`. The agent is told which custom types exist, so it can use
them on its own.

## Trust
`render.js` runs in the orb page (like the built-in renderers). On a single-user
box that's your own code — fine. Don't add an "install from a URL" path without
sandboxing (iframe) first.
