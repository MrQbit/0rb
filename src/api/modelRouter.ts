/**
 * Model router — default to the LOCAL model, and (when enabled + an OpenRouter
 * key is set) route a turn to a stronger cloud model by intent, to cut cost
 * while keeping quality where it matters.
 *
 * Strategy: OpenRouter is one OpenAI-compatible endpoint that fronts both
 * OpenAI and Anthropic models, so a single key + the existing OpenAI request
 * path covers "GPT and Claude" with no provider-specific code.
 *
 * Capability safety: voice stays local (latency); image turns only route to a
 * vision-capable cloud model (the defaults — gpt-4o / claude — are). Tool use
 * works on every routed model because the tools ride in the same request.
 */

export interface RouteDecision { model: string; baseURL: string; apiKey: string }
export interface RouteInput { text: string; hasImage?: boolean; channel?: string }

const OPENROUTER = 'https://openrouter.ai/api/v1'

function routerEnabled(): boolean {
  return process.env.RAK00N_ROUTER_ENABLED === '1' && !!(process.env.RAK00N_OPENROUTER_KEY || '').trim()
}
function strongModel(): string {
  return (process.env.RAK00N_ROUTER_STRONG_MODEL || 'openai/gpt-4o').trim()
}
/** Whether the configured strong model can see images (so vision turns are safe to route). */
function strongIsVision(): boolean {
  const m = strongModel().toLowerCase()
  // Conservative allowlist of vision-capable families on OpenRouter.
  return /gpt-4o|gpt-4\.1|o4|claude-3|claude-3\.5|claude-3\.7|gemini|llama-3\.2-vision|qwen.*vl/.test(m)
}

const CODING = /\b(code|coding|debug|refactor|stack ?trace|exception|function|regex|sql|typescript|javascript|python|rust|golang|compile|algorithm|implement|unit test|bug)\b/i
const REASONING = /\b(analy[sz]e|explain why|step[- ]by[- ]step|reason through|prove|derive|optimi[sz]e|trade[- ]?offs?|architecture|design (a|the)|plan (a|the)|strateg(y|ize)|compare .* (vs|versus))\b/i

/**
 * Decide where this turn should run. Returns a cloud override, or null to use
 * the local default.
 */
export function routeTurn(input: RouteInput): RouteDecision | null {
  if (!routerEnabled()) return null
  // Voice → always local for snappy back-and-forth.
  if (input.channel === 'voice') return null
  // Don't route image turns to a non-vision cloud model — keep them on local
  // Qwen-VL instead (it sees images).
  if (input.hasImage && !strongIsVision()) return null

  const t = input.text || ''
  const wantsStrong = t.length > 600 || CODING.test(t) || REASONING.test(t)
  if (!wantsStrong) return null            // simple/quick → local (free)

  return { model: strongModel(), baseURL: OPENROUTER, apiKey: (process.env.RAK00N_OPENROUTER_KEY as string).trim() }
}

/** For diagnostics / the settings UI. */
export function routerStatus() {
  return {
    enabled: routerEnabled(),
    keyed: !!(process.env.RAK00N_OPENROUTER_KEY || '').trim(),
    strongModel: strongModel(),
  }
}
