/**
 * Topic-policy evaluator.
 *
 * Pure function (apart from one optional outbound LLM call) so it can
 * be reused by both the chat dispatch path and the test endpoint.
 * Failure of the LLM classifier is treated as "no match" — the
 * agent loop continues as if the policy module weren't installed.
 */
import type { TopicPolicy, TopicRule } from './topicPolicy.js'

export type EvaluateResult = {
  matched: TopicRule[]
  rider: string | null
  classifier: 'keyword' | 'llm' | 'none'
}

type CacheEntry = { ts: number; result: EvaluateResult }
const CACHE = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60_000
const CACHE_MAX = 256

function sha256Hex(s: string): string {
  // Synchronous best-effort hash; we don't need a strong digest, only
  // a stable cache key that survives the request lifecycle.
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16)
}

function cacheGet(key: string): EvaluateResult | null {
  const e = CACHE.get(key)
  if (!e) return null
  if (Date.now() - e.ts > CACHE_TTL_MS) {
    CACHE.delete(key)
    return null
  }
  return e.result
}

function cachePut(key: string, result: EvaluateResult): void {
  if (CACHE.size >= CACHE_MAX) {
    const firstKey = CACHE.keys().next().value
    if (firstKey) CACHE.delete(firstKey)
  }
  CACHE.set(key, { ts: Date.now(), result })
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compilePatterns(rule: TopicRule): RegExp[] {
  const out: RegExp[] = []
  for (const p of rule.patterns) {
    const raw = p.trim()
    if (!raw) continue
    try {
      if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
        // Regex literal like /foo|bar/i
        const last = raw.lastIndexOf('/')
        const body = raw.slice(1, last)
        const flags = raw.slice(last + 1) || 'i'
        out.push(new RegExp(body, flags))
      } else {
        out.push(new RegExp(`\\b${escapeRegex(raw)}\\b`, 'i'))
      }
    } catch {
      out.push(new RegExp(escapeRegex(raw), 'i'))
    }
  }
  return out
}

function buildRider(template: string, matched: TopicRule[]): string {
  const list = matched
    .map(r => `- ${r.topic}${r.description ? `: ${r.description}` : ''}`)
    .join('\n')
  return template.replace('{{topics}}', list)
}

function buildAllowListRider(template: string, allowed: TopicRule[]): string {
  const list = allowed
    .map(r => `- ${r.topic}${r.description ? `: ${r.description}` : ''}`)
    .join('\n')
  return template.replace('{{topics}}', list)
}

async function classifyWithLlm(
  message: string,
  rules: TopicRule[],
  model: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const baseUrl = process.env.ANTHROPIC_FOUNDRY_BASE_URL || ''
  const apiKey = process.env.ANTHROPIC_FOUNDRY_API_KEY || ''
  if (!baseUrl || !apiKey) return new Set()

  const candidates = rules.filter(r => r.enabled && (r.examples?.length || 0) > 0)
  if (candidates.length === 0) return new Set()

  const url = baseUrl.replace(/\/+$/, '') + '/v1/messages'
  const topicsBlock = candidates
    .map(r =>
      `- id: ${r.id}\n  topic: ${r.topic}${r.description ? `\n  description: ${r.description}` : ''}\n  examples:\n    ${(r.examples || []).map(e => `- "${e.replace(/"/g, '\\"')}"`).join('\n    ')}`,
    )
    .join('\n')

  const prompt =
    `Classify whether the user message is about ANY of these topics. Reply with ONLY a JSON object of the form {"matches": ["<topic_id>", ...]} — an empty array if no topic matches. Do not include any other text.\n\n` +
    `Topics:\n${topicsBlock}\n\n` +
    `User message:\n"""${message.slice(0, 2000)}"""`

  const timeout = AbortSignal.timeout(2500)
  const composite: AbortSignal = signal
    ? (AbortSignal as any).any?.([signal, timeout]) ?? timeout
    : timeout

  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        system: 'You are a topic classifier. Reply with strict JSON only.',
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: composite,
    })
  } catch {
    return new Set()
  }
  if (!resp.ok) return new Set()
  let parsed: any
  try { parsed = await resp.json() } catch { return new Set() }
  const text: string = parsed?.content?.[0]?.text || ''
  const jsonStart = text.indexOf('{')
  const jsonEnd = text.lastIndexOf('}')
  if (jsonStart < 0 || jsonEnd <= jsonStart) return new Set()
  try {
    const obj = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as { matches?: unknown }
    if (Array.isArray(obj.matches)) {
      return new Set(obj.matches.filter((x): x is string => typeof x === 'string'))
    }
  } catch { /* ignore */ }
  return new Set()
}

export async function evaluateTopicPolicy(args: {
  message: string
  policy: import('./topicPolicy.js').TopicPolicy
  signal?: AbortSignal
}): Promise<EvaluateResult> {
  const { message, policy } = args
  if (policy.mode === 'off') {
    return { matched: [], rider: null, classifier: 'none' }
  }
  const cacheKey = `${policy.version}|${sha256Hex(message)}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  const enabledRules = policy.rules.filter(r => r.enabled)

  // Step 1: keyword/regex pass.
  const matched: TopicRule[] = []
  for (const r of enabledRules) {
    const regs = compilePatterns(r)
    if (regs.some(re => re.test(message))) {
      matched.push(r)
    }
  }
  let usedClassifier: 'keyword' | 'llm' | 'none' = matched.length ? 'keyword' : 'none'

  // Step 2: optional LLM fallback (when no keywords hit AND policy chose hybrid|llm).
  if (matched.length === 0 && (policy.classifier === 'hybrid' || policy.classifier === 'llm')) {
    const model = policy.llm_model || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6'
    const matches = await classifyWithLlm(message, enabledRules, model, args.signal)
    if (matches.size > 0) {
      for (const r of enabledRules) if (matches.has(r.id)) matched.push(r)
      if (matched.length) usedClassifier = 'llm'
    }
  }

  let rider: string | null = null
  if (policy.mode === 'deny_list') {
    if (matched.length > 0) {
      rider = buildRider(policy.rider_template, matched)
    }
  } else if (policy.mode === 'allow_list') {
    if (matched.length === 0) {
      rider = buildAllowListRider(policy.rider_template, enabledRules)
    }
  }

  const result: EvaluateResult = { matched, rider, classifier: usedClassifier }
  cachePut(cacheKey, result)
  return result
}

export function clearTopicPolicyCache(): void {
  CACHE.clear()
}
