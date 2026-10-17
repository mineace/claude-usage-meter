import type { EngineInterface, Register } from 'claude-code'

import {
  COMPACT_INSTRUCTIONS,
  advice,
  brief,
  critical,
  describeLimits,
  handoffNotice,
  handoffPrompt,
  handoffRequest,
  isOff,
  label,
  parseLimits,
  reached,
  report,
  windDown,
  wrapUpNotice,
} from './usage'
import type { Limits } from './usage'

const TOOL = 'mcp__usage-pacer__get_usage'
const THRESHOLDS = [75, 90]

type Stored = { text: string; limits?: Limits; compactFirst?: boolean }

// Stores the levels as the /config rows would, so they hold in later sessions, on any surface.
async function storeLimits(
  $: EngineInterface,
  next: Partial<Limits>,
  compactFirst: boolean | undefined,
  current: Limits,
  currentCompact: boolean,
): Promise<Stored> {
  const limits = { ...current, ...next }
  const rows: [string, number | boolean][] = []
  if (next.percent !== undefined) rows.push(['usage-pacer.handoffAt', next.percent])
  if (next.tokens !== undefined) rows.push(['usage-pacer.handoffTokens', next.tokens])
  if (compactFirst !== undefined) rows.push(['usage-pacer.compactFirst', compactFirst])
  for (const [key, value] of rows) {
    const { deny } = await $.config.set({ key, value })
    if (deny) return { text: `Could not change ${key}: ${deny}` }
  }
  const compact = compactFirst ?? currentCompact
  return { text: describeLimits(limits, compact), limits, compactFirst: compact }
}

export const register: Register = (on, options) => {
  let limits: Limits = {
    percent: Number(options.handoffAt ?? 65),
    tokens: Number(options.handoffTokens ?? 300_000),
  }
  let compactFirst = options.compactFirst !== false
  // Where this context window stands: compacted once already, and what Claude has been told.
  let compacted = false
  let toldWrapUp = false
  let toldHandoff = false
  let requestedHandoff = false
  let cwd = '.'
  // Highest threshold already announced per window, so each one toasts once.
  const announced = new Map<string, number>()
  // Highest wind-down level already sent to Claude per window (kind + reset time).
  const warned = new Map<string, number>()

  const freshContext = () => {
    compacted = false
    toldWrapUp = false
    toldHandoff = false
    requestedHandoff = false
  }

  const applied = (r: Stored) => {
    if (r.limits) limits = r.limits
    if (r.compactFirst !== undefined) compactFirst = r.compactFirst
    toldWrapUp = false
    toldHandoff = false
    return r.text
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    cwd = started.cwd
    await $.tool.register({
      name: 'get_usage',
      description:
        "Reports the user's current Claude plan usage: the 5-hour and 7-day rate-limit windows " +
        '(percent used and reset time), how full the context window is, and the session cost. ' +
        'Call it before starting large or long-running work (big refactors, many subagents, ' +
        'wide searches) to decide how much to take on, and when the per-prompt usage note looks high.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.command.register({
      name: 'handoff-at',
      description: 'Show or set when Claude hands off to a fresh agent: 40%, 300k, both, or off',
      argumentHint: '[40% | 300k | 40% 300k | off]',
    })
    await $.tool.register({
      name: 'set_handoff_level',
      description:
        'Sets when usage-pacer hands the task to a fresh agent: a context percentage, a token count, or both ' +
        '(whichever is reached first; 0 turns that one off), and whether it compacts once first. ' +
        'Call it only when the user asks to change the handoff settings.',
      inputSchema: {
        type: 'object',
        properties: {
          percent: { type: 'integer', minimum: 0, maximum: 99 },
          tokens: { type: 'integer', minimum: 0 },
          compactFirst: { type: 'boolean' },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'handoff',
      description:
        'Hands the current task to a fresh agent in this same environment when the context window is ' +
        'nearly full: saves your handoff to a file, clears the conversation once your turn ends, and starts ' +
        'the fresh agent with the handoff as its first prompt. Call it only when a usage-pacer notice asks ' +
        'you to, or the user does. The summary is all the fresh agent will know.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Goal, what is done, what remains (in order), key files and commands, decisions and why, problems hit.',
          },
        },
        required: ['summary'],
      },
      isDeferred: false,
    })
    $.ui.status(brief(await $.session.usage()) || undefined)
    return started
  })

  on('tool.call', { tool: /^mcp__usage-pacer__get_usage$/ }, async $ => ({
    result: `${report(await $.session.usage(), await $.clock.now())}\n${describeLimits(limits, compactFirst)}`,
  })).catch(() => ({ result: 'Usage figures are unavailable right now.' }))

  on('command.run', { command: 'handoff-at' }, async ($, e) => {
    const args = (e.args ?? '').trim()
    if (!args) return { text: `${describeLimits(limits, compactFirst)} Change it with /handoff-at 40%, 300k, 40% 300k or off.` }
    const parsed = parseLimits(args)
    if (!parsed) return { text: `"${args}" is not a level: use 40% (1-99), 300k or 1.2m (10k or more), both, or off.` }
    return { text: applied(await storeLimits($, parsed, undefined, limits, compactFirst)) }
  })

  on('tool.call', { tool: /^mcp__usage-pacer__set_handoff_level$/ }, async ($, e) => {
    const { percent, tokens, compactFirst: compact } = e as { percent?: number; tokens?: number; compactFirst?: boolean }
    const next: Partial<Limits> = {}
    if (percent !== undefined) next.percent = percent
    if (tokens !== undefined) next.tokens = tokens
    return { result: applied(await storeLimits($, next, compact, limits, compactFirst)) }
  }).catch(() => ({ result: 'Could not change the handoff settings.' }))

  on('tool.call', { tool: /^mcp__usage-pacer__handoff$/ }, async ($, e) => {
    const summary = String((e as { summary?: unknown }).summary ?? '').trim()
    if (!summary) return { result: 'Handoff not started: the summary is empty.' }
    const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
    const path = `${cwd}/.claude/handoffs/handoff-${stamp}.md`
    await $.fs.write(path, `# Handoff ${stamp}\n\n${summary}\n`)
    // Clearing has to wait for this turn to end; the command and the prompt queue until idle.
    $.clock.after(0, async () => {
      await $.command.run({ command: 'clear' })
      freshContext()
      await $.prompt.submit({ text: handoffPrompt(path, summary) })
    })
    $.ui.toast('Handing off to a fresh agent')
    return {
      result:
        `Handoff saved to ${path}. When this turn ends the conversation is cleared and a fresh agent ` +
        'starts from the handoff. End your turn now with one line telling the user it was handed off.',
    }
  }).catch(() => ({ result: 'Handoff failed; keep working and tell the user.' }))

  // Mid-turn notices ride on the next tool result: a long turn sees no new prompt.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const u = await $.session.usage()
    const notices: string[] = []
    const notice = windDown(u.rateLimits, warned)
    if (notice) {
      notices.push(notice)
      $.ui.toast('Usage nearly exhausted: asked Claude to wind down')
    }
    if (!isOff(limits) && reached(u.context, limits)) {
      if (critical(u.context, limits) && !toldHandoff) {
        // Too full to wait for the turn to end.
        toldHandoff = true
        toldWrapUp = true
        notices.push(handoffNotice(u.context))
        $.ui.toast('Context nearly full: asked Claude to hand off now')
      } else if (!toldWrapUp) {
        // Never interrupt: steer toward a stopping point and act when the turn ends.
        toldWrapUp = true
        notices.push(wrapUpNotice(u.context, compactFirst && !compacted))
      }
    }
    if (!notices.length) return ran
    return { ...ran, context: [...(ran.context ?? []), ...notices] }
  }).catch(($, e, next) => next(e))

  // Between turns: compact once to let the task carry on, then hand off the next time.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId || e.reason !== 'answer' || isOff(limits) || requestedHandoff) return done
    const u = await $.session.usage()
    if (!reached(u.context, limits)) return done
    if (compactFirst && !compacted) {
      compacted = true
      $.ui.toast(`Context at ${u.context.percent ?? 0}%: compacting before a handoff is needed`)
      $.clock.after(0, async () => {
        await $.session.compact({ instructions: COMPACT_INSTRUCTIONS })
        toldWrapUp = false
        toldHandoff = false
      })
    } else {
      requestedHandoff = true
      $.ui.toast(`Context at ${u.context.percent ?? 0}%: asking Claude to hand off`)
      $.clock.after(0, () => void $.prompt.submit({ text: handoffRequest(u.context) }))
    }
    return done
  }).catch(($, e, next) => next(e))

  // A compaction from anywhere (auto, /compact) counts as the one before the handoff.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && e.trigger !== 'precompute' && !('skip' in r && r.skip)) {
      compacted = true
      toldWrapUp = false
      toldHandoff = false
    }
    return r
  })

  on('session.end', ($, e, next) => {
    if (e.reason === 'clear') freshContext()
    return next(e)
  })

  // A one-line usage note rides along with every prompt, so planning starts informed.
  on('prompt.submit', async ($, e, next) => {
    const u = await $.session.usage()
    const line = brief(u)
    if (!line) return next(e)
    const past = !isOff(limits) && reached(u.context, limits)
    const a = past
      ? 'Context is past the handoff level: keep this turn focused and avoid large new work; usage-pacer acts when the turn ends.'
      : advice(u)
    const note = `[usage-pacer] Current usage: ${line}.${a ? ` ${a}` : ''} Call ${TOOL} for reset times and detail.`
    return next({ ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    $.ui.status(brief(e) || undefined)
    for (const l of e.rateLimits) {
      const hit = THRESHOLDS.filter(t => l.percentUsed >= t).pop() ?? 0
      if (hit > (announced.get(l.kind) ?? 0)) $.ui.toast(`${label(l.kind)} at ${l.percentUsed}%`)
      announced.set(l.kind, hit)
    }
    return next(e)
  })
}
