import type { EngineInterface, Register } from 'claude-code'

import { advice, brief, describeLevel, handoffNotice, handoffPrompt, label, parseLevel, report, windDown } from './usage'

const TOOL = 'mcp__usage-pacer__get_usage'
const THRESHOLDS = [75, 90]

type Stored = { text: string; level?: number }

// Stores the level as the /config row would, so it holds in later sessions, on any surface.
async function storeLevel($: EngineInterface, raw: string): Promise<Stored> {
  const level = parseLevel(raw)
  if (level === undefined) return { text: `"${raw}" is not a level: use a whole number from 1 to 99, or off.` }
  const { deny } = await $.config.set({ key: 'usage-pacer.handoffAt', value: level })
  if (deny) return { text: `Could not change the handoff level: ${deny}` }
  return { text: describeLevel(level), level }
}

export const register: Register = (on, options) => {
  let handoffAt = Number(options.handoffAt ?? 75)
  // Whether Claude was already asked to hand off in this context window.
  let askedHandoff = false
  let cwd = '.'
  // Highest threshold already announced per window, so each one toasts once.
  const announced = new Map<string, number>()
  // Highest wind-down level already sent to Claude per window (kind + reset time).
  const warned = new Map<string, number>()

  // Keeps this load in step with a level just stored.
  const applied = (r: Stored) => {
    if (r.level !== undefined) {
      handoffAt = r.level
      askedHandoff = false
    }
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
      description: 'Show or set the context % at which Claude hands off to a fresh agent (off to disable)',
      argumentHint: '[percent | off]',
    })
    await $.tool.register({
      name: 'set_handoff_level',
      description:
        'Sets the context-window percentage at which usage-pacer asks you to hand off to a fresh agent ' +
        '(0 turns handoff off). Call it only when the user asks to change or turn off the handoff level.',
      inputSchema: {
        type: 'object',
        properties: { percent: { type: 'integer', minimum: 0, maximum: 99 } },
        required: ['percent'],
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
    result: report(await $.session.usage(), await $.clock.now()),
  })).catch(() => ({ result: 'Usage figures are unavailable right now.' }))

  on('command.run', { command: 'handoff-at' }, async ($, e) => ({
    text: (e.args ?? '').trim() ? applied(await storeLevel($, e.args)) : `${describeLevel(handoffAt)} Change it with /handoff-at <percent | off>.`,
  }))

  on('tool.call', { tool: /^mcp__usage-pacer__set_handoff_level$/ }, async ($, e) => ({
    result: applied(await storeLevel($, String((e as { percent?: unknown }).percent ?? ''))),
  })).catch(() => ({ result: 'Could not change the handoff level.' }))

  on('tool.call', { tool: /^mcp__usage-pacer__handoff$/ }, async ($, e) => {
    const summary = String((e as { summary?: unknown }).summary ?? '').trim()
    if (!summary) return { result: 'Handoff not started: the summary is empty.' }
    const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
    const path = `${cwd}/.claude/handoffs/handoff-${stamp}.md`
    await $.fs.write(path, `# Handoff ${stamp}\n\n${summary}\n`)
    // Clearing has to wait for this turn to end; the command and the prompt queue until idle.
    $.clock.after(0, async () => {
      await $.command.run({ command: 'clear' })
      askedHandoff = false
      await $.prompt.submit({ text: handoffPrompt(path, summary) })
    })
    $.ui.toast('Handing off to a fresh agent')
    return {
      result:
        `Handoff saved to ${path}. When this turn ends the conversation is cleared and a fresh agent ` +
        'starts from the handoff. End your turn now with one line telling the user it was handed off.',
    }
  }).catch(() => ({ result: 'Handoff failed; keep working and tell the user.' }))

  // Mid-turn wind-down: a long turn sees no new prompt, so the notice rides on the
  // next tool result once a limit window crosses a wind-down level.
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
    const percent = u.context.percent ?? 0
    if (percent < handoffAt) askedHandoff = false
    else if (handoffAt > 0 && !askedHandoff) {
      askedHandoff = true
      notices.push(handoffNotice(percent))
      $.ui.toast(`Context ${percent}% full: asked Claude to hand off`)
    }
    if (!notices.length) return ran
    return { ...ran, context: [...(ran.context ?? []), ...notices] }
  }).catch(($, e, next) => next(e))

  // A one-line usage note rides along with every prompt, so planning starts informed.
  on('prompt.submit', async ($, e, next) => {
    const u = await $.session.usage()
    const line = brief(u)
    if (!line) return next(e)
    const percent = u.context.percent ?? 0
    const a = handoffAt > 0 && percent >= handoffAt ? handoffNotice(percent).replace('[usage-pacer] ', '') : advice(u)
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
