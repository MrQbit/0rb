/**
 * Intent hint — advisory-only classifier.
 *
 * The goal is to nudge ORB2 toward calling SubmitJob for clearly
 * long-running asks, so the user isn't blocked while the agent grinds
 * through a multi-minute task. The classifier is HEURISTIC ONLY and
 * intentionally conservative: false negatives (missing a long-running
 * intent) are far cheaper than false positives (telling the agent to
 * background a quick interactive question, which would feel dumber to
 * the user).
 *
 * Output is appended to the user message as a tagged note. The agent
 * stays in full control: it can ignore the hint and answer inline, or
 * call SubmitJob to delegate. We never short-circuit the agent loop.
 *
 * No LLM calls — pure regex/length heuristics. Fail-open to "no hint".
 */

export type IntentHint = {
  kind: 'long_running' | 'unclear'
  reason: string
  triggers: string[]
}

// Verb phrases that strongly imply a multi-step long-running build/audit.
// Each entry is a regex; if the message matches any of them AND clears the
// length bar, we tag as long_running. Patterns are intentionally narrow.
const LONG_RUNNING_VERBS: { rx: RegExp; tag: string }[] = [
  { rx: /\baudit\s+(the\s+)?(entire\s+)?(codebase|repo|repository|project)\b/i, tag: 'audit-full-codebase' },
  { rx: /\b(run|execute)\s+(all|the\s+full|the\s+entire)\s+test/i, tag: 'run-all-tests' },
  { rx: /\b(refactor|migrate)\s+(the\s+)?(entire|whole|all)\s+/i, tag: 'large-refactor' },
  { rx: /\bbuild\s+(me\s+)?(a|the)\s+(full|complete|entire)\s+(feature|app|service|microservice)/i, tag: 'build-feature' },
  { rx: /\bgenerate\s+(a\s+)?(full|complete|comprehensive)\s+(report|analysis|audit)/i, tag: 'generate-large-report' },
  { rx: /\bdeploy\s+(to\s+)?(prod|production|staging)/i, tag: 'deploy' },
  { rx: /\bcreate\s+(and\s+open\s+)?(a\s+)?(pr|pull\s+request)\s+(for|to)\s+/i, tag: 'open-pr' },
  { rx: /\bscan\s+(the\s+)?(entire|whole|all)\s+(codebase|repo|project)\b/i, tag: 'scan-full-codebase' },
  { rx: /\bcrawl\s+(the\s+|all\s+)/i, tag: 'crawl' },
]

// Phrases that suggest an interactive Q&A even if length is high.
// If any of these hit, we never tag long_running.
const INTERACTIVE_OVERRIDE: RegExp[] = [
  /\bwhat\s+(does|is|are)\b/i,
  /\bhow\s+(does|do|can)\b/i,
  /\bwhy\s+(does|is|are)\b/i,
  /\bexplain\b/i,
  /\bsummarize\b/i,
  /\bshow\s+me\b/i,
  /\bwhere\s+is\b/i,
]

// Minimum message length to even consider tagging — short prompts are
// almost always interactive and the cost of getting them wrong is high.
const MIN_LENGTH_FOR_HINT = 80

/**
 * Classify a user message. Always fail-open: any error or any doubt
 * returns null, which means "no hint, agent runs as normal". The
 * agent loop is never altered structurally.
 */
export function classifyIntent(message: string): IntentHint | null {
  if (typeof message !== 'string' || message.length === 0) return null
  const trimmed = message.trim()
  if (trimmed.length < MIN_LENGTH_FOR_HINT) return null

  // Hard override: if the message reads like an interactive question,
  // do not tag. This is the cheap protection against false positives.
  for (const rx of INTERACTIVE_OVERRIDE) {
    if (rx.test(trimmed)) return null
  }

  const triggers: string[] = []
  for (const v of LONG_RUNNING_VERBS) {
    if (v.rx.test(trimmed)) triggers.push(v.tag)
  }

  if (triggers.length === 0) return null

  return {
    kind: 'long_running',
    reason: 'message contains explicit long-running verbs',
    triggers,
  }
}

/**
 * Compose a one-paragraph hint to prepend to the user message. The
 * agent reads it as a system note. Phrasing avoids commanding the
 * agent — it suggests, so ORB2 stays in charge of its own plan.
 */
export function renderHint(hint: IntentHint): string {
  const tagList = hint.triggers.join(', ')
  return [
    '[SYSTEM: Intent hint — advisory only]',
    `This message looks like a long-running task (triggers: ${tagList}).`,
    'If you agree, prefer to:',
    '  1. Add the work to your todo list via TodoWrite.',
    '  2. Use SubmitJob to delegate the heavy execution so the user is not blocked. Pass requires_approval=false unless the user must approve.',
    '  3. Reply briefly that the job has been started and continue listening for further user messages.',
    'If the message is actually a quick interactive question, ignore this hint and answer inline as usual.',
  ].join('\n')
}
