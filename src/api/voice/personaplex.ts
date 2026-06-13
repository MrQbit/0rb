/**
 * PersonaPlex (Moshi) client — checks whether the local PersonaPlex
 * server is running and ready on port 8998.
 */

const PERSONAPLEX_URL = process.env.ORB2_PERSONAPLEX_URL || 'https://localhost:8998'

export type PersonaplexStatus = {
  running: boolean
  url: string
  voice_prompt: string
}

export async function isPersonaplexReady(): Promise<boolean> {
  try {
    const res = await fetch(`${PERSONAPLEX_URL}/`, {
      signal: AbortSignal.timeout(2_000),
    })
    return res.ok || res.status < 500
  } catch {
    return false
  }
}

export async function getPersonaplexStatus(): Promise<PersonaplexStatus> {
  const running = await isPersonaplexReady()
  return {
    running,
    url: PERSONAPLEX_URL,
    voice_prompt: process.env.ORB2_VOICE_VOICE_PROMPT || 'NATM0.pt',
  }
}
