/**
 * Vercel connector — deploy a published page to a real public vercel.app URL
 * (offloads serving from the box; truly public, no tailnet needed). Uses a
 * Vercel access token (vercel.com/account/tokens). Optional team id.
 */
export function vercelEnabled(): boolean {
  return !!(process.env.ORB2_VERCEL_TOKEN || '').trim()
}

const TEXT_EXT = new Set(['html', 'css', 'js', 'mjs', 'json', 'svg', 'txt', 'xml'])

/** Deploy a set of files; returns the public https URL. */
export async function deployToVercel(files: { path: string; content: Buffer | string }[], name = 'orb2-share'): Promise<string> {
  const token = (process.env.ORB2_VERCEL_TOKEN || '').trim()
  if (!token) throw new Error('Vercel is not connected (ORB2_VERCEL_TOKEN unset)')
  const project = (name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || 'orb2-share'
  const apiFiles = files.map(f => {
    const ext = (f.path.split('.').pop() || '').toLowerCase()
    if (typeof f.content === 'string' || TEXT_EXT.has(ext)) {
      return { file: f.path, data: f.content.toString('utf8') }
    }
    return { file: f.path, data: (f.content as Buffer).toString('base64'), encoding: 'base64' as const }
  })
  const teamId = (process.env.ORB2_VERCEL_TEAM_ID || '').trim()
  const url = `https://api.vercel.com/v13/deployments${teamId ? `?teamId=${teamId}` : ''}`
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: project, files: apiFiles, projectSettings: { framework: null }, target: 'production' }),
  })
  if (!r.ok) throw new Error(`vercel http ${r.status}: ${(await r.text()).slice(0, 240)}`)
  const d = (await r.json()) as any
  const host = d.alias?.[0] || d.url
  if (!host) throw new Error('vercel: no deployment url returned')
  return host.startsWith('http') ? host : `https://${host}`
}
