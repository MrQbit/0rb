/**
 * Per-user GitHub OAuth token storage.
 *
 * Tokens are obtained via the device flow (see {@link
 * ../../services/github/deviceFlow}) and persisted server-side keyed
 * by the requesting identity's OID. They are then used by the worker
 * pod's git credential helper when the agent runs `git push` / `git
 * clone` against github.com.
 *
 * Storage (Redis):
 *   orb2:github:user:{oid}   -> JSON { token, login, scopes, granted_at, name?, email? }
 *
 * The token is the only sensitive bit; we never log it and only emit
 * { login, scopes, granted_at, name, email } back to the client via
 * /v1/auth/github/status. Worker dispatches pass the token through to
 * the worker pod's git credential helper as gitCredentials.password
 * exactly the same way the GitHub App installation token does today.
 */
import type { Store } from '../store/store.js'

const KEY_PREFIX = 'orb2:github:user:'

export type StoredGitHubToken = {
  token: string
  login: string
  scopes: string[]
  granted_at: string
  /** Optional name field captured at sign-in for git commit identity. */
  name?: string
  /** Optional commit email captured at sign-in (may be noreply). */
  email?: string
}

function keyFor(oid: string): string {
  return `${KEY_PREFIX}${oid}`
}

// GitHub user tokens don't expire by default; we still bound them to
// 30 days so a long-idle user has to re-authenticate. Override with
// ORB2_GH_USER_TOKEN_TTL_SECONDS at deploy time.
const TOKEN_TTL_SECONDS = Math.max(
  60 * 60,
  parseInt(process.env.ORB2_GH_USER_TOKEN_TTL_SECONDS ?? '', 10) || 30 * 24 * 60 * 60,
)

export async function saveGitHubUserToken(
  store: Store,
  oid: string,
  record: StoredGitHubToken,
): Promise<void> {
  if (!oid) throw new Error('oid is required to persist a github user token')
  await store.putKv(keyFor(oid), JSON.stringify(record), TOKEN_TTL_SECONDS)
}

export async function loadGitHubUserToken(
  store: Store,
  oid: string,
): Promise<StoredGitHubToken | null> {
  if (!oid) return null
  const raw = await store.getKv(keyFor(oid))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as StoredGitHubToken
    if (parsed && typeof parsed.token === 'string' && parsed.token.length > 0) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

export async function deleteGitHubUserToken(
  store: Store,
  oid: string,
): Promise<void> {
  if (!oid) return
  try {
    await store.delKv(keyFor(oid))
  } catch { /* noop */ }
}

/** Fetch the authenticated GitHub user profile to extract login + commit email. */
export async function fetchGitHubUserProfile(
  token: string,
): Promise<{ login: string; name?: string; email?: string } | null> {
  if (!token) return null
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'orb2-api',
      },
    })
    if (!res.ok) return null
    const data = (await res.json()) as Record<string, unknown>
    const login = typeof data.login === 'string' ? data.login : ''
    if (!login) return null
    const name = typeof data.name === 'string' ? data.name : undefined
    const profileEmail = typeof data.email === 'string' && data.email ? data.email : undefined
    let email = profileEmail
    if (!email) {
      try {
        const emailsRes = await fetch('https://api.github.com/user/emails', {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'orb2-api',
          },
        })
        if (emailsRes.ok) {
          const list = (await emailsRes.json()) as Array<{ email: string; primary?: boolean; verified?: boolean }>
          const primary = list.find(e => e.primary && e.verified) ?? list.find(e => e.verified) ?? list[0]
          if (primary?.email) email = primary.email
        }
      } catch { /* tolerate scope mismatch */ }
    }
    return { login, name, email }
  } catch {
    return null
  }
}
