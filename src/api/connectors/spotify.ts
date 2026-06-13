/**
 * Spotify connector — search via the Client Credentials flow (app token, no
 * user login). Enough to search tracks and embed the player (open.spotify.com
 * /embed/...) which plays full tracks if the listener is signed into Spotify
 * in their browser, otherwise a 30s preview. Configure RAK00N_SPOTIFY_CLIENT_ID
 * + RAK00N_SPOTIFY_CLIENT_SECRET (developer.spotify.com → an app).
 */
export function spotifyEnabled(): boolean {
  return !!((process.env.RAK00N_SPOTIFY_CLIENT_ID || '').trim() && (process.env.RAK00N_SPOTIFY_CLIENT_SECRET || '').trim())
}

let tokenCache = { token: '', exp: 0 }
async function spotifyToken(): Promise<string> {
  const id = (process.env.RAK00N_SPOTIFY_CLIENT_ID || '').trim()
  const sec = (process.env.RAK00N_SPOTIFY_CLIENT_SECRET || '').trim()
  if (!id || !sec) throw new Error('Spotify is not connected (client id/secret unset)')
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${id}:${sec}`).toString('base64') },
    body: 'grant_type=client_credentials',
  })
  if (!r.ok) throw new Error(`spotify token http ${r.status}`)
  const d = (await r.json()) as any
  tokenCache = { token: d.access_token, exp: Date.now() + ((d.expires_in || 3600) - 60) * 1000 }
  return tokenCache.token
}

export type SpTrack = { title: string; artist: string; url: string; embed: string; thumbnail?: string }

export async function spotifySearch(query: string, max = 8): Promise<SpTrack[]> {
  const tok = await spotifyToken()
  const r = await fetch(`https://api.spotify.com/v1/search?type=track&limit=${Math.min(max, 15)}&q=${encodeURIComponent(query)}`, {
    headers: { authorization: 'Bearer ' + tok },
  })
  if (!r.ok) throw new Error(`spotify http ${r.status}`)
  const d = (await r.json()) as any
  return (d.tracks?.items || []).map((t: any) => ({
    title: t.name,
    artist: (t.artists || []).map((a: any) => a.name).join(', '),
    url: t.external_urls?.spotify || '',
    embed: `https://open.spotify.com/embed/track/${t.id}`,
    thumbnail: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url,
  }))
}
