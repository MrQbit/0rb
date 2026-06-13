/**
 * Model fallback chain for Foundry 503/529 resilience.
 *
 * When the primary model returns repeated 503 (service unavailable) or
 * 529 (overloaded) errors, the agent runner retries sequentially
 * through healthy models discovered at boot time. Cross-account
 * fallback (e.g. Anthropic → OpenAI Foundry) gives the best
 * resilience since a 503 on one account rarely affects another.
 *
 * The chain is recomputed on every /v1/models/reprobe or when the
 * probe cache is invalidated, so newly-deployed models are picked up
 * without a restart.
 */

type ModelEntry = {
  id: string
  provider: string
  status: string
}

/**
 * Build an ordered fallback chain from the probed model list.
 * The primary model is excluded; remaining healthy models are sorted
 * to prefer cross-provider diversity (if the primary is anthropic,
 * prefer openai first and vice versa).
 */
export function buildFallbackChain(
  primaryModel: string,
  availableModels: ModelEntry[],
): string[] {
  const healthy = availableModels.filter(
    m => m.status === 'available' && m.id !== primaryModel,
  )
  if (healthy.length === 0) return []

  const primary = availableModels.find(m => m.id === primaryModel)
  const primaryProvider = primary?.provider ?? ''

  // Sort: cross-provider first (different Foundry account = independent
  // failure domain), then same-provider alternatives.
  return healthy
    .sort((a, b) => {
      const aIsCross = a.provider !== primaryProvider ? 0 : 1
      const bIsCross = b.provider !== primaryProvider ? 0 : 1
      return aIsCross - bIsCross
    })
    .map(m => m.id)
}

/**
 * Detect whether an agent turn result indicates a model-level failure
 * (503/529 exhaustion, connection error, zero tokens) that warrants
 * trying the next model in the fallback chain.
 */
export function isModelFailure(result: {
  promptTokens: number
  completionTokens: number
  interrupted: boolean
  fullText: string
}): boolean {
  if (result.interrupted) return false
  if (result.promptTokens > 0 || result.completionTokens > 0) return false
  // Zero tokens + error text = the model never responded.
  const lower = result.fullText.toLowerCase()
  return (
    lower.includes('error') ||
    lower.includes('503') ||
    lower.includes('529') ||
    lower.includes('overloaded') ||
    lower.includes('service unavailable') ||
    lower.includes('api error') ||
    lower.includes('cannot retry') ||
    lower.includes('connection') ||
    lower.length === 0
  )
}
