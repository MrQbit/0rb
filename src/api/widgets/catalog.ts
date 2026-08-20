/**
 * The widget catalog as a constraint surface (v0.2 §5 + §10).
 *
 * This is orb's A2UI: the model composes UI from a versioned catalog of
 * trusted types — declarative data in, native renderers out. Specs are
 * validated on emit (unknown fields stripped, unknown types rejected unless
 * a runtime plugin registered them), each type carries an ATTENTION tier
 * (how much of the user's attention it may claim) and a REFRESH mode
 * (whether a pinned copy can live-update or renders a snapshot).
 *
 *   ambient   → idle boards, never interrupts, no motion
 *   glance    → floating card, silent
 *   notify    → card + chime/push allowed
 *   interrupt → spoken aloud — must be earned (approvals, safety)
 */
import { createHash } from 'node:crypto'

export type Attention = 'ambient' | 'glance' | 'notify' | 'interrupt'
export type Refresh = 'live' | 'snapshot'
type FieldKind = 'string' | 'number' | 'boolean' | 'array' | 'object'

export interface CatalogEntry {
  fields: Record<string, FieldKind>
  attention: Attention
  refresh: Refresh
  hint: string
}

const S = 'string' as const, N = 'number' as const, B = 'boolean' as const, A = 'array' as const, O = 'object' as const

export const CATALOG: Record<string, CatalogEntry> = {
  note: { fields: { text: S }, attention: 'glance', refresh: 'snapshot', hint: 'formatted text' },
  table: { fields: { columns: A, rows: A }, attention: 'glance', refresh: 'snapshot', hint: 'columns+rows' },
  stats: { fields: { stats: A }, attention: 'glance', refresh: 'snapshot', hint: 'metric cards [{label,value,sub}]' },
  results: { fields: { items: A }, attention: 'glance', refresh: 'snapshot', hint: 'search results [{title,subtitle,url,thumbnail}]' },
  chart: { fields: { chart_type: S, labels: A, datasets: A }, attention: 'glance', refresh: 'snapshot', hint: 'line|bar|pie' },
  gallery: { fields: { images: A }, attention: 'glance', refresh: 'snapshot', hint: 'images [{url,caption}]' },
  image: { fields: { url: S, caption: S }, attention: 'glance', refresh: 'snapshot', hint: 'one image' },
  weather: { fields: { location: S, unit: S, units: S, current: O, forecast: A }, attention: 'ambient', refresh: 'live', hint: 'current+forecast' },
  calendar: { fields: { month: S, events: A, _monthOffset: N }, attention: 'ambient', refresh: 'live', hint: 'month grid + events' },
  code: { fields: { code: S, text: S, language: S, lang: S, filename: S }, attention: 'glance', refresh: 'snapshot', hint: 'syntax-highlighted source' },
  mail: { fields: { messages: A }, attention: 'glance', refresh: 'live', hint: 'inbox rows' },
  vercel: { fields: { deployments: A, deployment: O }, attention: 'glance', refresh: 'live', hint: 'deployments' },
  map: { fields: { center: A, zoom: N, markers: A, route: O }, attention: 'glance', refresh: 'snapshot', hint: 'pins + routes' },
  docker: { fields: { containers: A }, attention: 'glance', refresh: 'live', hint: 'containers + controls' },
  home: { fields: { devices: A }, attention: 'ambient', refresh: 'live', hint: 'device dashboard' },
  todo: { fields: { items: A }, attention: 'glance', refresh: 'live', hint: 'live task list' },
  app: { fields: { url: S }, attention: 'glance', refresh: 'snapshot', hint: 'workspace-served app iframe' },
  html: { fields: { html: S, url: S }, attention: 'glance', refresh: 'snapshot', hint: 'bespoke sandboxed HTML' },
  embed: { fields: { url: S }, attention: 'glance', refresh: 'snapshot', hint: 'external embed' },
  video: { fields: { url: S, provider: S }, attention: 'glance', refresh: 'snapshot', hint: 'video player' },
  music: { fields: { url: S }, attention: 'glance', refresh: 'snapshot', hint: 'music embed' },
  model: { fields: { url: S, dims: S, watertight: B }, attention: 'glance', refresh: 'snapshot', hint: '3D model viewer' },
  calculator: { fields: {}, attention: 'glance', refresh: 'snapshot', hint: 'interactive calculator' },
  document: { fields: { url: S, text: S, name: S, format: S, mime: S }, attention: 'glance', refresh: 'snapshot', hint: 'document viewer' },
  wallet: { fields: { methods: A, selected: S }, attention: 'glance', refresh: 'live', hint: 'payment methods' },
  shopping: { fields: { items: A, options: A }, attention: 'glance', refresh: 'live', hint: 'shopping list' },
  lights: { fields: { groups: A }, attention: 'ambient', refresh: 'live', hint: 'room-grouped light control' },
  media: { fields: { entity_id: S, name: S, kind: S, area: S, state: S, media_title: S, app: S, volume: N, artwork: S }, attention: 'glance', refresh: 'live', hint: 'media remote' },
  climate: { fields: { entity_id: S, name: S, area: S, state: S, current: N, target: N }, attention: 'ambient', refresh: 'live', hint: 'thermostat dial' },
  vacuum: { fields: { entity_id: S, area: S, state: S, battery: N, fan: S }, attention: 'glance', refresh: 'live', hint: 'vacuum control' },
  covers: { fields: { groups: A }, attention: 'glance', refresh: 'live', hint: 'shades by room' },
  security: { fields: { locks: A, sensors: A }, attention: 'ambient', refresh: 'live', hint: 'locks + sensors' },
  plugs: { fields: { groups: A }, attention: 'glance', refresh: 'live', hint: 'plugs by room' },
  scenes: { fields: { scenes: A }, attention: 'glance', refresh: 'snapshot', hint: 'one-tap scenes' },
  sensors: { fields: { groups: A }, attention: 'ambient', refresh: 'live', hint: 'readings by room' },
  camera: { fields: { name: S, snapshot: S }, attention: 'glance', refresh: 'live', hint: 'camera snapshot' },
  timers: { fields: { timers: A }, attention: 'ambient', refresh: 'live', hint: 'countdowns' },
  presence: { fields: { people: A, pill: S }, attention: 'ambient', refresh: 'live', hint: "who's home" },
  automations: { fields: { automations: A }, attention: 'glance', refresh: 'live', hint: 'HA automations' },
  printer3d: { fields: { name: S, state: S, progress: N, layer: N, total_layers: N, nozzle: N, nozzle_target: N, bed: N, bed_target: N, remaining_min: N, snapshot: S, stream: S, controls: B }, attention: 'glance', refresh: 'live', hint: '3D printer' },
  familyboard: { fields: { notes: A, events: A }, attention: 'ambient', refresh: 'live', hint: 'family notes + events' },
  briefing: { fields: { briefing: O }, attention: 'ambient', refresh: 'snapshot', hint: 'day at a glance' },
  housemode: { fields: { mode: S }, attention: 'ambient', refresh: 'live', hint: 'home|away|vacation|guest' },
  setup: { fields: { integration: S, flow: O }, attention: 'notify', refresh: 'snapshot', hint: 'device pairing form' },
  approval: { fields: { approval_id: S, summary: S, reason: S, tool: S, action_key: S, offer_always: B, expires_at: N, resolved: B, approved: B }, attention: 'notify', refresh: 'snapshot', hint: 'action awaiting approval' },
  deck: { fields: { cards: A }, attention: 'ambient', refresh: 'snapshot', hint: 'morning digest card stack' },
  receipts: { fields: { receipts: A }, attention: 'glance', refresh: 'live', hint: 'action ledger + undo' },
}

const ATTENTION_ORDER: Attention[] = ['ambient', 'glance', 'notify', 'interrupt']

let _version = ''
export function catalogVersion(): string {
  if (!_version) _version = createHash('sha256').update(JSON.stringify(CATALOG)).digest('hex').slice(0, 8)
  return _version
}

/** Terse prompt block (~600 tokens) — names + field hints, not schemas. */
export function catalogPromptBlock(): string {
  const lines = Object.entries(CATALOG).map(([t, e]) => {
    const fields = Object.keys(e.fields).slice(0, 8).join(',')
    return `${t}(${fields})${e.hint ? ` — ${e.hint}` : ''}`
  })
  return `WIDGET CATALOG v${catalogVersion()} — the Widget tool renders these types (field names shown):\n${lines.join('; ')}`
}

const PASSTHROUGH = new Set(['id', 'type', 'title', 'pill', 'pending', 'attention', 'context'])

export interface ValidationResult { ok: boolean; spec: any; stripped: string[]; reason?: string }

/** Validate + clean a spec against the catalog. Unknown types pass only when
 *  a runtime plugin claims them (checked by the caller). */
export function validateSpec(spec: any, isPlugin: (t: string) => boolean = () => false): ValidationResult {
  if (!spec || typeof spec.type !== 'string') return { ok: false, spec, stripped: [], reason: 'no type' }
  const entry = CATALOG[spec.type]
  if (!entry) {
    return isPlugin(spec.type)
      ? { ok: true, spec, stripped: [] }
      : { ok: false, spec, stripped: [], reason: `unknown type ${spec.type}` }
  }
  const cleaned: any = {}
  const stripped: string[] = []
  for (const [k, v] of Object.entries(spec)) {
    if (PASSTHROUGH.has(k) || k in entry.fields) cleaned[k] = v
    else stripped.push(k)
  }
  // Attention may only be LOWERED from the type's tier, never raised.
  const maxIdx = ATTENTION_ORDER.indexOf(entry.attention)
  const askIdx = spec.attention ? ATTENTION_ORDER.indexOf(spec.attention) : -1
  cleaned.attention = askIdx >= 0 && askIdx < maxIdx ? spec.attention : entry.attention
  return { ok: true, spec: cleaned, stripped }
}

export function attentionOf(type: string): Attention {
  return CATALOG[type]?.attention ?? 'glance'
}

export function catalogJson(): any {
  return { version: catalogVersion(), types: CATALOG }
}
