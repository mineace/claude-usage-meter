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

/** What tells Claude to hand off, once the context window reaches the configured level. */
export const handoffNotice = (percent: number) =>
  `[usage-pacer] Context window is ${percent}% full. Hand off now: finish only the step in progress ` +
  `(save or commit it if the project uses git), then call ${HANDOFF_TOOL} with a complete handoff: ` +
  'the goal, what is done, what remains in order, key files and commands, decisions made and why, ' +
  'and anything that went wrong. A fresh agent in this same environment continues from it with an empty context; ' +
  'it sees only what you write there.'

/** The prompt the fresh agent starts from. */
export const handoffPrompt = (path: string, summary: string) =>
  `You are continuing work handed off by a previous agent whose context window filled up. ` +
  `Its handoff (also saved at ${path}):\n\n${summary}\n\n` +
  'Check the current state of the files before acting on it, then carry on with what remains.'

/** Reads a handoff level as typed: `60`, `60%`, `off` or `0`; undefined when it is neither. */
export const parseLevel = (raw: string) => {
  const text = raw.trim().toLowerCase().replace(/%$/, '')
  if (text === 'off') return 0
  const n = Number(text)
  return text !== '' && Number.isInteger(n) && n >= 0 && n <= 99 ? n : undefined
}

export const describeLevel = (level: number) =>
  level > 0 ? `Handoff is set to ${level}% context.` : 'Handoff is off.'
