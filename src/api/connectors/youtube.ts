/**
 * YouTube connector — search via the YouTube Data API v3 (API key only, no
 * OAuth). Returns clean video results the agent shows as a results widget.
 * Configure RAK00N_YOUTUBE_API_KEY (Google Cloud → YouTube Data API v3 key).
 */
export function youtubeEnabled(): boolean {
  return !!(process.env.RAK00N_YOUTUBE_API_KEY || '').trim()
}

export type YtResult = { title: string; channel: string; videoId: string; url: string; thumbnail?: string }

export async function youtubeSearch(query: string, max = 8): Promise<YtResult[]> {
  const key = (process.env.RAK00N_YOUTUBE_API_KEY || '').trim()
  if (!key) throw new Error('YouTube is not connected (RAK00N_YOUTUBE_API_KEY unset)')
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${Math.min(max, 15)}&q=${encodeURIComponent(query)}&key=${key}`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`youtube http ${r.status}: ${(await r.text()).slice(0, 160)}`)
  const d = (await r.json()) as any
  return (d.items || [])
    .filter((it: any) => it?.id?.videoId)
    .map((it: any) => ({
      title: it.snippet?.title || '',
      channel: it.snippet?.channelTitle || '',
      videoId: it.id.videoId,
      url: `https://www.youtube.com/watch?v=${it.id.videoId}`,
      thumbnail: it.snippet?.thumbnails?.medium?.url || it.snippet?.thumbnails?.default?.url,
    }))
}
