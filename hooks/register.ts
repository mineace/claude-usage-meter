import type { Register } from 'claude-code'

import { advice, brief, label, report, windDown } from './usage'

const TOOL = 'mcp__usage-pacer__get_usage'
const THRESHOLDS = [75, 90]

export const register: Register = on => {
  // Highest threshold already announced per window, so each one toasts once.
  const announced = new Map<string, number>()
  // Highest wind-down level already sent to Claude per window (kind + reset time).
  const warned = new Map<string, number>()

  on('session.start', async ($, e, next) => {
    const started = await next(e)
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
    $.ui.status(brief(await $.session.usage()) || undefined)
    return started
  })

  on('tool.call', { tool: /^mcp__usage-pacer__get_usage$/ }, async $ => ({
    result: report(await $.session.usage(), await $.clock.now()),
  })).catch(() => ({ result: 'Usage figures are unavailable right now.' }))

  // Mid-turn wind-down: a long turn sees no new prompt, so the notice rides on the
  // next tool result once a limit window crosses a wind-down level.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const notice = windDown((await $.session.usage()).rateLimits, warned)
    if (!notice) return ran
    $.ui.toast('Usage nearly exhausted: asked Claude to wind down')
    return { ...ran, context: [...(ran.context ?? []), notice] }
  }).catch(($, e, next) => next(e))

  // A one-line usage note rides along with every prompt, so planning starts informed.
  on('prompt.submit', async ($, e, next) => {
    const u = await $.session.usage()
    const line = brief(u)
    if (!line) return next(e)
    const a = advice(u)
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
