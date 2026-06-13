/**
 * Widget registry — the catalog behind Settings → Apps. Each entry describes a
 * widget the orb can show: what it is, what category it's in, and what (if any)
 * setup it needs. Status is computed live (configured? enabled?) so the UI can
 * render a searchable grid with on/off toggles and a Configure action.
 *
 * Setup kinds:
 *   none      — pure display / free keyless data → always available, on by default
 *   owner-key — one shared app key/secret the OWNER sets once (safe to share:
 *               returns only public data, no per-user leak) e.g. YouTube, Spotify
 *   oauth     — each user connects their OWN account (Google / Microsoft)
 *   token     — each user pastes their own service token (Vercel, GitHub)
 *   local     — backed by a local service on the box (Docker, Blender)
 */
import type { Store } from '../store/store.js'
import { connectedProviders } from '../connectors/cloudStorage.js'
import { listPlugins } from './plugins.js'

export type WidgetSetup = 'none' | 'owner-key' | 'oauth' | 'token' | 'local'

export interface WidgetDef {
  id: string
  name: string
  desc: string
  category: 'Display' | 'Info' | 'Media' | 'Productivity' | 'Dev' | 'Account'
  setup: WidgetSetup
  icon: string                 // emoji glyph (kept lightweight; UI may map to SVG)
  envKeys?: string[]           // env keys that must be set for `configured`
  provider?: 'google' | 'microsoft' | 'spotify' | 'vercel' | 'github'
  ownerAction?: boolean        // owner must obtain a one-time common key
}

export interface WidgetStatus extends WidgetDef {
  enabled: boolean
  configured: boolean
  note?: string                // short setup hint when not configured
}

/** The catalog. Order roughly by how often a fresh user meets them. */
export const WIDGET_CATALOG: WidgetDef[] = [
  // ── Display (agent-generated, no setup) ──
  { id: 'chart', name: 'Chart', desc: 'Bar / line / pie graphs from data.', category: 'Display', setup: 'none', icon: '📊' },
  { id: 'table', name: 'Table', desc: 'Columns and rows.', category: 'Display', setup: 'none', icon: '▦' },
  { id: 'stats', name: 'Stats', desc: 'A row of metric cards.', category: 'Display', setup: 'none', icon: '📈' },
  { id: 'gallery', name: 'Gallery', desc: 'A grid of images.', category: 'Display', setup: 'none', icon: '🖼️' },
  { id: 'image', name: 'Image', desc: 'One image with a caption.', category: 'Display', setup: 'none', icon: '🏞️' },
  { id: 'code', name: 'Code', desc: 'Syntax-highlighted source, read-only.', category: 'Display', setup: 'none', icon: '⟨⟩' },
  { id: 'note', name: 'Note', desc: 'Formatted markdown / text.', category: 'Display', setup: 'none', icon: '📝' },
  { id: 'calculator', name: 'Calculator', desc: 'An interactive calculator.', category: 'Display', setup: 'none', icon: '🧮' },
  { id: 'html', name: 'Custom app', desc: 'A bespoke hand-written interactive app.', category: 'Display', setup: 'none', icon: '✦' },
  { id: 'embed', name: 'Embed', desc: 'Embed any external interactive page (e.g. a 3D model).', category: 'Display', setup: 'none', icon: '🔗' },

  // ── Info (free, keyless data) ──
  { id: 'weather', name: 'Weather', desc: 'Current conditions + 5-day forecast for any place.', category: 'Info', setup: 'none', icon: '☀️' },
  { id: 'map', name: 'Maps & directions', desc: 'Places, pins and driving routes (OpenStreetMap).', category: 'Info', setup: 'none', icon: '🗺️' },
  { id: 'calendar', name: 'Calendar', desc: 'A month calendar with events and an agenda.', category: 'Info', setup: 'none', icon: '📅' },
  { id: 'todo', name: 'Tasks', desc: 'A live task list the orb opens and ticks along during long/multi-step work.', category: 'Productivity', setup: 'none', icon: '☑️' },
  { id: 'websearch', name: 'Web search & news', desc: 'Headlines and search via your self-hosted SearXNG.', category: 'Info', setup: 'none', icon: '🔎', envKeys: ['RAK00N_SEARXNG_URL'] },

  // ── Media (one shared owner key — safe to share, public data only) ──
  { id: 'youtube', name: 'YouTube', desc: 'Search and play videos.', category: 'Media', setup: 'owner-key', icon: '▶️', envKeys: ['RAK00N_YOUTUBE_API_KEY'], ownerAction: true },
  { id: 'spotify', name: 'Spotify', desc: 'Search music and play embeds.', category: 'Media', setup: 'owner-key', icon: '🎵', envKeys: ['RAK00N_SPOTIFY_CLIENT_ID', 'RAK00N_SPOTIFY_CLIENT_SECRET'], provider: 'spotify', ownerAction: true },

  // ── Account (per-user OAuth / token) ──
  { id: 'gmail', name: 'Gmail / mail', desc: 'Inbox preview from your connected account.', category: 'Account', setup: 'oauth', icon: '✉️', provider: 'google' },
  { id: 'gcal', name: 'Google Calendar', desc: 'Your live calendar and agenda.', category: 'Account', setup: 'oauth', icon: '📆', provider: 'google' },
  { id: 'gdrive', name: 'Google Drive', desc: 'Search and pull your Drive files.', category: 'Account', setup: 'oauth', icon: '📁', provider: 'google' },
  { id: 'outlook', name: 'Outlook mail', desc: 'Inbox preview from Microsoft 365.', category: 'Account', setup: 'oauth', icon: '📧', provider: 'microsoft' },
  { id: 'mscal', name: 'Microsoft Calendar', desc: 'Your Outlook calendar.', category: 'Account', setup: 'oauth', icon: '🗓️', provider: 'microsoft' },
  { id: 'onedrive', name: 'OneDrive', desc: 'Search and pull your OneDrive files.', category: 'Account', setup: 'oauth', icon: '☁️', provider: 'microsoft' },
  { id: 'vercel', name: 'Vercel', desc: 'Deployment status; publish public pages.', category: 'Dev', setup: 'token', icon: '▲', envKeys: ['RAK00N_VERCEL_TOKEN'], provider: 'vercel' },
  { id: 'github', name: 'GitHub', desc: 'Repos, issues and PRs.', category: 'Dev', setup: 'token', icon: '⌥', provider: 'github' },

  // ── Dev / local ──
  { id: 'docker', name: 'Docker', desc: 'Live containers — start/stop/logs.', category: 'Dev', setup: 'local', icon: '🐳', envKeys: ['RAK00N_DOCKER_OPS_ENABLED'] },
  { id: 'blender', name: '3D model', desc: 'Generate and orbit a 3D model (Blender).', category: 'Dev', setup: 'local', icon: '🧊', envKeys: ['RAK00N_BLENDER_URL'] },
]

function envSet(keys?: string[]): boolean {
  if (!keys || !keys.length) return true
  return keys.every(k => !!(process.env[k] && String(process.env[k]).trim()))
}

const DISABLED_SETTING = 'RAK00N_WIDGETS_DISABLED'

function disabledSet(): Set<string> {
  return new Set((process.env[DISABLED_SETTING] || '').split(',').map(s => s.trim()).filter(Boolean))
}

const SETUP_NOTE: Record<WidgetSetup, string> = {
  none: '',
  'owner-key': 'Needs a one-time app key (owner)',
  oauth: 'Connect your account',
  token: 'Add your access token',
  local: 'Needs its local service',
}

export async function getWidgetRegistry(store: Store): Promise<WidgetStatus[]> {
  const off = disabledSet()
  let connected: string[] = []
  try { connected = await connectedProviders(store) } catch { /* none */ }
  const builtins = WIDGET_CATALOG.map(w => {
    let configured: boolean
    if (w.setup === 'oauth' && w.provider) configured = connected.includes(w.provider as any)
    else configured = envSet(w.envKeys)
    return {
      ...w,
      enabled: !off.has(w.id),
      configured,
      note: configured ? undefined : SETUP_NOTE[w.setup],
    }
  })
  // Custom plugins (runtime, no recompile) appear in the registry too.
  let plugins: WidgetStatus[] = []
  try {
    plugins = listPlugins().map(p => ({
      id: p.id, name: p.name, desc: p.description || 'Custom widget',
      category: 'Custom' as any, setup: 'none' as WidgetSetup, icon: p.icon || '🧩',
      enabled: !off.has(p.id), configured: true,
    }))
  } catch { /* none */ }
  return [...builtins, ...plugins]
}

/** Toggle a widget on/off by editing the comma-separated disabled list. */
export function toggleWidgetDisabled(id: string, enabled: boolean): string {
  const off = disabledSet()
  if (enabled) off.delete(id)
  else off.add(id)
  return [...off].join(',')
}
