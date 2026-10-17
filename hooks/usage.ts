import type { SessionUsage, SessionRateLimit } from 'claude-code'

const LABELS: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: '7-day limit',
  spend_limit: 'spend limit',
}

export const label = (kind: string) => LABELS[kind] ?? kind

const until = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const mins = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))
  const span = mins >= 1440 ? `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`
    : mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m`
    : `${mins}m`
  return `, resets in ${span} (${iso})`
}

/** Levels at which Claude is told, mid-turn, to wrap up; each fires once per window. */
export const WIND_DOWN = [95, 98]

const WIND_DOWN_TEXT =
  'Plan usage is about to run out: wind down now. Do not start new steps. Save your work ' +
  '(commit it if the project uses git), then stop and tell the user what is done and what remains, ' +
  'with enough detail to resume after the limit resets.'

/** The wind-down notice for the limit windows that just crossed a level, or undefined. */
export const windDown = (limits: readonly SessionRateLimit[], warned: Map<string, number>) => {
  const crossed: SessionRateLimit[] = []
  for (const l of limits) {
    const key = `${l.kind}@${l.resetsAt ?? ''}`
    const level = WIND_DOWN.filter(t => l.percentUsed >= t).pop() ?? 0
    if (level > (warned.get(key) ?? 0)) crossed.push(l)
    warned.set(key, Math.max(level, warned.get(key) ?? 0))
  }
  if (!crossed.length) return undefined
  const which = crossed.map(l => `${label(l.kind)} at ${l.percentUsed}%${l.resetsAt ? ` (resets ${l.resetsAt})` : ''}`)
  return `[usage-pacer] ${which.join(', ')}. ${WIND_DOWN_TEXT}`
}

export const worst = (limits: readonly SessionRateLimit[]) =>
  limits.reduce((max, l) => Math.max(max, l.percentUsed), 0)

export const advice = (u: Pick<SessionUsage, 'rateLimits' | 'context'>) => {
  const plan = worst(u.rateLimits)
  const ctx = u.context.percent ?? 0
  const notes: string[] = []
  if (plan >= WIND_DOWN[0]!) notes.push(WIND_DOWN_TEXT)
  else if (plan >= 90) notes.push('Plan usage is nearly exhausted: finish or checkpoint the current task, avoid spawning subagents, and prefer small, targeted steps.')
  else if (plan >= 75) notes.push('Plan usage is high: avoid broad exploration and parallel subagents; prioritise the most important work.')
  else if (u.rateLimits.length) notes.push('Plan usage leaves room for normal work.')
  if (ctx >= 80) notes.push('Context window is nearly full: expect compaction soon; summarise progress before large reads.')
  return notes.join(' ')
}

/** Full report, for the tool. */
export const report = (u: SessionUsage, now: number) => {
  const lines: string[] = []
  if (u.rateLimits.length) {
    for (const l of u.rateLimits) lines.push(`- ${label(l.kind)}: ${l.percentUsed}% used${until(l.resetsAt, now)}`)
  } else {
    lines.push('- Plan limits: not reported (not on a subscription, or no response received yet this session).')
  }
  const c = u.context
  lines.push(c.tokens === undefined
    ? `- Context window: ${c.window.toLocaleString()} tokens (no response yet to measure fill)`
    : `- Context window: ${c.tokens.toLocaleString()} / ${c.window.toLocaleString()} tokens (${c.percent ?? 0}%)`)
  if (u.cost) lines.push(`- Session cost so far: $${u.cost.usd.toFixed(2)}`)
  const mins = Math.round((now - u.startedAt) / 60000)
  lines.push(`- Session age: ${mins} min`)
  const a = advice(u)
  return `Current usage (as of ${new Date(now).toISOString()}):\n${lines.join('\n')}${a ? `\n\n${a}` : ''}`
}

/** One line, for each prompt and the status line. */
export const brief = (u: Pick<SessionUsage, 'rateLimits' | 'context' | 'cost'>) => {
  const parts = u.rateLimits.map(l => `${label(l.kind)} ${l.percentUsed}%`)
  if (u.context.percent !== undefined) parts.push(`context ${u.context.percent}%`)
  if (u.cost) parts.push(`$${u.cost.usd.toFixed(2)}`)
  return parts.join(' · ')
}

export const HANDOFF_TOOL = 'mcp__usage-pacer__handoff'

/** When to hand off: whichever of the two the context reaches first; 0 turns that one off. */
export type Limits = { percent: number; tokens: number }

type Ctx = Pick<SessionUsage['context'], 'percent' | 'tokens'>

export const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

const fill = (c: Ctx) => `${c.percent ?? 0}% / ${fmtTokens(c.tokens ?? 0)} tokens`

export const isOff = (l: Limits) => l.percent <= 0 && l.tokens <= 0

/** The handoff level is reached: past the percent or the token count, whichever comes first. */
export const reached = (c: Ctx, l: Limits) =>
  (l.percent > 0 && (c.percent ?? 0) >= l.percent) || (l.tokens > 0 && (c.tokens ?? 0) >= l.tokens)

/** Past the point where waiting for the turn to end risks running out: hand off mid-turn. */
export const critical = (c: Ctx, l: Limits) =>
  !isOff(l) && ((c.percent ?? 0) >= 90 || (l.tokens > 0 && (c.tokens ?? 0) >= 2 * l.tokens))

export const describeLimits = (l: Limits, compactFirst: boolean) => {
  if (isOff(l)) return 'Handoff is off.'
  const parts = [l.percent > 0 ? `${l.percent}% context` : '', l.tokens > 0 ? `${fmtTokens(l.tokens)} tokens` : '']
  const how = compactFirst ? 'compacts once first, then hands off the next time' : 'hands off'
  return `Handoff level: ${parts.filter(Boolean).join(' or ')}, whichever comes first; at the end of a turn past it, usage-pacer ${how}.`
}

/**
 * Reads a level as typed: `40%` or `40` (percent), `300k`, `1.2m` or `300000` (tokens), both
 * (`40% 300k`), or `off`; undefined when a part is neither. Parts not given are left as they are.
 */
export const parseLimits = (raw: string): Partial<Limits> | undefined => {
  const parts = raw.trim().toLowerCase().split(/[\s,]+/).filter(Boolean)
  if (!parts.length) return undefined
  if (parts.length === 1 && parts[0] === 'off') return { percent: 0, tokens: 0 }
  const out: Partial<Limits> = {}
  for (const part of parts) {
    const m = /^(\d+(?:\.\d+)?)(%|k|m)?$/.exec(part)
    if (!m) return undefined
    const n = Number(m[1])
    const unit = m[2] ?? (n <= 100 ? '%' : '')
    if (unit === '%') {
      if (!Number.isInteger(n) || n < 1 || n > 99) return undefined
      out.percent = n
    } else {
      const tokens = Math.round(n * (unit === 'k' ? 1000 : unit === 'm' ? 1_000_000 : 1))
      if (tokens < 10_000) return undefined
      out.tokens = tokens
    }
  }
  return out
}

/** Mid-turn, once the level is reached: keep going, but steer toward a stopping point. */
export const wrapUpNotice = (c: Ctx, compacting: boolean) =>
  `[usage-pacer] Context is at ${fill(c)}, past the handoff level. Do not stop mid-task, but do not start ` +
  'new large pieces of work: finish what you are doing and end your turn at a natural stopping point. ' +
  (compacting
    ? 'When the turn ends the conversation is compacted once, keeping the task in progress, so the work can continue.'
    : `When the turn ends you will be asked to write a handoff for a fresh agent.`)

/** Mid-turn, past the critical point: hand off without waiting for the turn to end. */
export const handoffNotice = (c: Ctx) =>
  `[usage-pacer] Context is at ${fill(c)}, close to full. Hand off now: finish only the step in progress ` +
  `(save or commit it if the project uses git), then call ${HANDOFF_TOOL} with a complete handoff: ` +
  'the goal, what is done, what remains in order, key files and commands, decisions made and why, ' +
  'and anything that went wrong. A fresh agent in this same environment continues from it with an empty context; ' +
  'it sees only what you write there.'

/** The prompt that asks for the handoff, between turns. */
export const handoffRequest = (c: Ctx) =>
  `[usage-pacer] The context window is at ${fill(c)}, past the handoff level. Write the handoff now, ` +
  `before doing anything else: save or commit work in progress if the project uses git, then call ${HANDOFF_TOOL} ` +
  'with the goal, what is done, what remains in order, key files and commands, decisions made and why, and ' +
  'anything that went wrong. A fresh agent continues from it with an empty context.'

/** What the compaction before a handoff should keep. */
export const COMPACT_INSTRUCTIONS =
  'Keep everything needed to continue the task in progress without asking: its goal, the plan with the steps ' +
  'done and still to do, files and commands involved, decisions made and why, and open problems.'

/** The prompt the fresh agent starts from. */
export const handoffPrompt = (path: string, summary: string) =>
  `You are continuing work handed off by a previous agent whose context window filled up. ` +
  `Its handoff (also saved at ${path}):\n\n${summary}\n\n` +
  'Check the current state of the files before acting on it, then carry on with what remains.'
