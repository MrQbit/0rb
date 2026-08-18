/**
 * Web search connector — private SearXNG first (self-hosted, no key), Brave
 * Search as an optional fallback (ORB2_BRAVE_API_KEY). Backs the WebSearch
 * tool; each result is { title, url, snippet }.
 */

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

export function webSearchEnabled(): boolean {
  return !!(process.env.ORB2_SEARXNG_URL || process.env.ORB2_BRAVE_API_KEY)
}

async function searxng(query: string, count: number): Promise<SearchHit[] | null> {
  const base = (process.env.ORB2_SEARXNG_URL || '').replace(/\/+$/, '')
  if (!base) return null
  const res = await fetch(`${base}/search?q=${encodeURIComponent(query)}&format=json`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return null
  const d = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> }
  return (d.results ?? []).slice(0, count).map(r => ({
    title: String(r.title || r.url || ''),
    url: String(r.url || ''),
    snippet: String(r.content || ''),
  })).filter(h => h.url)
}

async function brave(query: string, count: number): Promise<SearchHit[] | null> {
  const key = process.env.ORB2_BRAVE_API_KEY
  if (!key) return null
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
    { headers: { 'X-Subscription-Token': key, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) },
  )
  if (!res.ok) return null
  const d = (await res.json()) as any
  return (d?.web?.results ?? []).slice(0, count).map((r: any) => ({
    title: String(r.title || ''),
    url: String(r.url || ''),
    snippet: String(r.description || ''),
  })).filter((h: SearchHit) => h.url)
}

/** Search the web; SearXNG first, Brave fallback. Throws if neither works. */
export async function webSearch(query: string, count = 8): Promise<SearchHit[]> {
  let lastErr: Error | null = null
  try {
    const hits = await searxng(query, count)
    if (hits?.length) return hits
  } catch (e) { lastErr = e as Error }
  try {
    const hits = await brave(query, count)
    if (hits?.length) return hits
  } catch (e) { lastErr = e as Error }
  if (lastErr) throw lastErr
  return []
}
