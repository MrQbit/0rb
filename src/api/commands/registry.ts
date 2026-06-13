/**
 * REST-callable slash command registry.
 *
 * Each entry maps a command name to a prompt template + a JSON
 * schema for its arguments. The handler simply dispatches a chat
 * turn with the rendered prompt; the agent does the actual work
 * using its full tool palette.
 *
 * Why templates and not direct imports of `src/commands/*`? Those
 * commands are TUI-coupled (ink/React) and re-implementing them
 * here would either duplicate complex logic or risk drift. Letting
 * the agent run with a clear instruction is the right level of
 * abstraction for a REST API and stays in lockstep with the TUI.
 */

export type CommandSchema = {
  name: string
  description: string
  args_schema: {
    type: 'object'
    properties: Record<string, { type: string; description?: string }>
    required?: string[]
  }
  /** Builds the user message (and optional system prompt addition). */
  template: (args: Record<string, unknown>) => {
    message: string
    appendSystemPrompt?: string
    suggestedTools?: string[]
  }
  /** If true, the command intent is "long-running" so the agent will see the
   *  intent hint and likely delegate via SubmitJob. */
  long_running?: boolean
}

const asString = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : fallback

export const COMMANDS: Record<string, CommandSchema> = {
  commit: {
    name: 'commit',
    description: 'Stage relevant changes and create a git commit with a clear message.',
    args_schema: {
      type: 'object',
      properties: {
        message_hint: { type: 'string', description: 'Optional hint for the commit message.' },
        push: { type: 'boolean', description: 'Whether to push after committing.' },
      },
    },
    template: args => ({
      message: [
        'Run `git status` and `git diff` to inspect the working tree.',
        'Stage the relevant files with `git add`, then create a single concise commit.',
        asString(args.message_hint) ? `Hint for the commit message: ${asString(args.message_hint)}` : '',
        args.push === true ? 'Then push the commit to the current branch (`git push`).' : '',
        'Reply with the resulting commit hash and a one-line summary.',
      ].filter(Boolean).join(' '),
      suggestedTools: ['Bash', 'Read'],
    }),
  },

  diff: {
    name: 'diff',
    description: 'Show the working-tree diff with a short summary of what changed.',
    args_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Path or glob to limit the diff to.' },
      },
    },
    template: args => ({
      message:
        `Run \`git diff${asString(args.scope) ? ` -- ${asString(args.scope)}` : ''}\` ` +
        'and reply with a 1-3 sentence plain-English summary of what changed, ' +
        'followed by a fenced ```diff``` block of the patch.',
      suggestedTools: ['Bash'],
    }),
  },

  review: {
    name: 'review',
    description: 'Review uncommitted changes (or a PR/branch) for bugs, style issues, and missing tests.',
    args_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Optional branch or PR ref. Default: working tree vs HEAD.' },
        focus: { type: 'string', description: 'Optional focus area (e.g. "security", "performance").' },
      },
    },
    template: args => ({
      message: [
        `Review the${asString(args.target) ? ` changes for ${asString(args.target)}` : ' working-tree changes (HEAD vs index vs unstaged)'}.`,
        'Use git tools to inspect the diff. For each finding:',
        '- Severity (blocker/major/minor/nit)',
        '- File and line range',
        '- Specific recommendation',
        asString(args.focus) ? `Focus on: ${asString(args.focus)}.` : '',
        'Finish with a one-paragraph overall assessment.',
      ].filter(Boolean).join(' '),
      suggestedTools: ['Bash', 'Read', 'Grep', 'Glob'],
    }),
  },

  'security-review': {
    name: 'security-review',
    description: 'Run a security-focused review across STRIDE/OWASP categories.',
    args_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Optional path glob or branch ref.' },
      },
    },
    long_running: true,
    template: args => ({
      message: [
        'Perform a security-focused code review covering:',
        '- STRIDE (spoofing, tampering, repudiation, info disclosure, DoS, elevation)',
        '- OWASP Top 10',
        '- Supply-chain risk (deps, lockfile, scripts)',
        asString(args.scope) ? `Scope: ${asString(args.scope)}.` : '',
        'Report each finding with severity, location, and a concrete remediation.',
      ].filter(Boolean).join(' '),
      suggestedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    }),
  },

  brief: {
    name: 'brief',
    description: 'Produce a short brief of the repository\'s current state and recent activity.',
    args_schema: { type: 'object', properties: {} },
    template: () => ({
      message:
        'Produce a brief of this repository: top-level layout, primary languages, ' +
        'recent commits (last 10), open TODOs, and any obvious tech debt. ' +
        'Reply in <300 words.',
      suggestedTools: ['Bash', 'Read', 'Grep', 'Glob'],
    }),
  },

  init: {
    name: 'init',
    description: 'Bootstrap a new project skeleton in the current working directory.',
    args_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Project kind: node, python, go, rust, etc.' },
        name: { type: 'string', description: 'Project name.' },
      },
      required: ['kind'],
    },
    long_running: true,
    template: args => ({
      message: [
        `Initialize a new ${asString(args.kind)} project`,
        asString(args.name) ? ` named "${asString(args.name)}"` : '',
        ' in the current working directory. Set up package metadata, .gitignore, ',
        'a Hello-World entrypoint, and an initial test scaffold.',
      ].join(''),
      suggestedTools: ['Bash', 'Write', 'Edit'],
    }),
  },

  plan: {
    name: 'plan',
    description: 'Enter plan mode for the next set of changes.',
    args_schema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What you want to plan toward.' },
      },
      required: ['goal'],
    },
    template: args => ({
      message:
        `Enter plan mode and produce a concrete implementation plan for: ${asString(args.goal)}. ` +
        'Use the EnterPlanMode tool, then ExitPlanMode with a fenced markdown plan covering ' +
        'phases, files touched, and a rollout order. Do not start editing files.',
    }),
  },

  cost: {
    name: 'cost',
    description: 'Summarize token + USD cost for the current session.',
    args_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Optional session id (defaults to this turn\'s session).' },
      },
    },
    template: args => ({
      message:
        `Summarize the running cost for session "${asString(args.session_id, '<this session>')}". ` +
        'Use the audit log + your own bookkeeping to estimate prompt+completion tokens by model and ' +
        'translate to USD using rough industry pricing. Show a small table.',
    }),
  },

  insights: {
    name: 'insights',
    description: 'Extract insights from recent activity in this session/repo.',
    args_schema: { type: 'object', properties: {} },
    long_running: true,
    template: () => ({
      message:
        'Look at recent commits, open files, and tool-use history in this session. ' +
        'Produce 5-10 numbered insights about tech debt, hotspots, repeated patterns, and ' +
        'opportunities for cleanup. Be specific (cite files/lines).',
      suggestedTools: ['Bash', 'Read', 'Grep', 'Glob'],
    }),
  },

  doctor: {
    name: 'doctor',
    description: 'Run a system check and report environment health.',
    args_schema: { type: 'object', properties: {} },
    template: () => ({
      message:
        'Run a system health check: bun version, redis ping, foundry endpoint reachability, ' +
        'workspace fs writeability. For each item return a one-line OK/FAIL with detail.',
      suggestedTools: ['Bash'],
    }),
  },

  memory: {
    name: 'memory',
    description: 'Summarize and tag what to remember from the current session.',
    args_schema: {
      type: 'object',
      properties: {
        focus: { type: 'string', description: 'Optional focus area.' },
      },
    },
    template: args => ({
      message:
        `Summarize the most important things to remember from this session${asString(args.focus) ? ` about ${asString(args.focus)}` : ''}. ` +
        'Then write at most 3 vault notes via the appropriate tool, each with descriptive ' +
        'tags. Reply with the note paths and a one-line description for each.',
      suggestedTools: ['VaultWrite'],
    }),
  },
}

export function listCommands(): CommandSchema[] {
  return Object.values(COMMANDS)
}

export function getCommand(name: string): CommandSchema | null {
  return COMMANDS[name] ?? null
}
