/**
 * News connector — headlines/search via NewsAPI (newsapi.org, API key only).
 * Returns clean article results the agent shows as a results widget.
 * Configure RAK00N_NEWSAPI_KEY.
 */
export function newsEnabled(): boolean {
  return !!(process.env.RAK00N_NEWSAPI_KEY || '').trim()
}

export type NewsResult = { title: string; source: string; url: string; thumbnail?: string; description?: string }

export async function newsSearch(query: string, max = 8): Promise<NewsResult[]> {
  const key = (process.env.RAK00N_NEWSAPI_KEY || '').trim()
  if (!key) throw new Error('News is not connected (RAK00N_NEWSAPI_KEY unset)')
  // Use top-headlines for a topic/empty query, /everything for a specific one.
  const q = query.trim()
  const url = q
    ? `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&sortBy=publishedAt&language=en&pageSize=${Math.min(max, 15)}&apiKey=${key}`
    : `https://newsapi.org/v2/top-headlines?language=en&pageSize=${Math.min(max, 15)}&apiKey=${key}`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`news http ${r.status}: ${(await r.text()).slice(0, 160)}`)
  const d = (await r.json()) as any
  return (d.articles || []).map((a: any) => ({
    title: a.title || '',
    source: a.source?.name || '',
    url: a.url,
    thumbnail: a.urlToImage || undefined,
    description: a.description || '',
  }))
}
