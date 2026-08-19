/**
 * Smart-paste connector setup — recognize a pasted credential by shape and
 * map it to the right setting, so "here's my key: AIza…" just works without
 * the user knowing which box it belongs in.
 *
 * Detection is heuristic but conservative: unambiguous prefixes map to one
 * setting; ambiguous shapes (32-hex could be Spotify or NewsAPI) return all
 * candidates so the caller can ask one clarifying question.
 */

export interface KeyMatch {
  setting: string
  service: string
  /** true when the shape can only be this service */
  certain: boolean
  note?: string
}

export function detectKey(pasteRaw: string): KeyMatch[] {
  const paste = pasteRaw.trim()
  if (!paste || paste.length < 8 || /\s/.test(paste)) return []

  // Unambiguous prefixes first.
  if (/^AIza[0-9A-Za-z_-]{30,}$/.test(paste)) {
    return [{ setting: 'ORB2_YOUTUBE_API_KEY', service: 'YouTube (Google API key)', certain: true }]
  }
  if (/^sk-or-v1-[0-9a-f]{40,}$/i.test(paste)) {
    return [{ setting: 'ORB2_OPENROUTER_KEY', service: 'OpenRouter', certain: true, note: 'Also usable as the cloud brain (OPENAI_API_KEY with https://openrouter.ai/api/v1).' }]
  }
  if (/^sk-ant-/.test(paste)) {
    return [{ setting: 'OPENAI_API_KEY', service: 'Anthropic', certain: true, note: 'Pair with OPENAI_BASE_URL=https://api.anthropic.com/v1 and an Anthropic model id.' }]
  }
  if (/^sk-[A-Za-z0-9_-]{20,}$/.test(paste)) {
    return [{ setting: 'OPENAI_API_KEY', service: 'OpenAI', certain: true, note: 'Pair with OPENAI_BASE_URL=https://api.openai.com/v1.' }]
  }
  if (/^(ghp_|github_pat_)[A-Za-z0-9_]{20,}$/.test(paste)) {
    return [{ setting: 'GITHUB_TOKEN', service: 'GitHub', certain: true, note: 'Stored per user via Settings → Apps → GitHub, not a global env.' }]
  }
  if (/^tskey-auth-/.test(paste)) {
    return [{ setting: 'TAILSCALE_AUTHKEY', service: 'Tailscale', certain: true, note: 'Use Settings → Access → Connect (it joins the tailnet, not an env var).' }]
  }
  if (/^re_[A-Za-z0-9_]{16,}$/.test(paste)) {
    return [{ setting: 'RESEND_API_KEY', service: 'Resend', certain: true, note: 'Belongs on the hosted relay (Vercel env), not this box — sign-in email already works via the relay.' }]
  }
  if (/^BSA[A-Za-z0-9_-]{16,}$/.test(paste)) {
    return [{ setting: 'ORB2_BRAVE_API_KEY', service: 'Brave Search', certain: true }]
  }
  if (/^vcp_[A-Za-z0-9]{20,}$/.test(paste) || /^[A-Za-z0-9]{24}$/.test(paste) && paste.startsWith('vercel_')) {
    return [{ setting: 'ORB2_VERCEL_TOKEN', service: 'Vercel', certain: true }]
  }
  // Home Assistant long-lived tokens are JWTs with an "iss" of the HA install.
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(paste) && paste.length > 100) {
    return [{ setting: 'ORB2_HA_TOKEN', service: 'Home Assistant (long-lived token)', certain: true }]
  }
  // 32 hex chars: Spotify client id/secret or NewsAPI — ask.
  if (/^[0-9a-f]{32}$/i.test(paste)) {
    return [
      { setting: 'ORB2_SPOTIFY_CLIENT_ID', service: 'Spotify (client id)', certain: false },
      { setting: 'ORB2_SPOTIFY_CLIENT_SECRET', service: 'Spotify (client secret)', certain: false },
      { setting: 'ORB2_NEWSAPI_KEY', service: 'NewsAPI', certain: false },
    ]
  }
  return []
}
