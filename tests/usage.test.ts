import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptSubmitInput } from 'claude-code'

const USAGE = {
  startedAt: 0,
  context: { tokens: 170_000, window: 200_000, percent: 85, isAutoCompactEnabled: true },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 92, resetsAt: '2030-01-01T05:00:00Z' },
    { kind: 'seven_day', percentUsed: 40, resetsAt: '2030-01-06T00:00:00Z' },
  ],
  cost: { usd: 3.5 },
}

const stub = (on: On) => {
  on('session.usage', () => ({ value: USAGE }) as never)
  on('clock.now', () => ({ value: Date.parse('2030-01-01T02:30:00Z') }) as never)
}

test('get_usage reports limits, resets, context and advice', async ($, on) => {
  stub(on)
  const r = await $.tool.call({ tool: 'mcp__usage-pacer__get_usage' } as never)
  const text = String((r as { result?: unknown }).result ?? (r as { text?: string }).text)
  expect(text).toContain('5-hour limit: 92% used')
  expect(text).toContain('7-day limit: 40% used')
  expect(text).toContain('resets in 2h 30m')
  expect(text).toContain('170,000 / 200,000 tokens (85%)')
  expect(text).toContain('$3.50')
  expect(text).toContain('nearly exhausted')
})

test('each prompt carries a one-line usage note', async ($, on) => {
  stub(on)
  let seen: PromptSubmitInput | undefined
  on('prompt.submit', (_$, e) => {
    seen = e
    return { text: e.text } as never
  })
  await $.prompt.submit({ text: 'refactor everything' } as never)
  expect(seen?.context?.join('\n') ?? '').toContain('5-hour limit 92% · 7-day limit 40% · context 85% · $3.50')
})

test('a tool result carries the wind-down notice once per level', async ($, on) => {
  let percent = 96
  on('session.usage', () => ({
    value: { ...USAGE, rateLimits: [{ kind: 'five_hour', percentUsed: percent, resetsAt: '2030-01-01T05:00:00Z' }] },
  }) as never)
  on('tool.call', () => ({ result: 'ok' }) as never)
  const first = await $.tool.call({ tool: 'Read', file_path: 'a.md' } as never)
  expect(JSON.stringify(first)).toContain('wind down now')
  const second = await $.tool.call({ tool: 'Read', file_path: 'a.md' } as never)
  expect(JSON.stringify(second)).not.toContain('wind down now')
  percent = 98
  const third = await $.tool.call({ tool: 'Read', file_path: 'a.md' } as never)
  expect(JSON.stringify(third)).toContain('5-hour limit at 98%')
})

const atContext = (on: On, percent: number, tokens = percent * 1000) => {
  on('session.usage', () => ({
    value: { ...USAGE, rateLimits: [], context: { tokens, window: 1_000_000, percent, isAutoCompactEnabled: true } },
  }) as never)
}

const read = ($: Engine) =>
  $.tool.call({ tool: 'Read', file_path: 'a.md' } as never).then(r => JSON.stringify(r))

const SUMMARY = { role: 'user', text: 'summary', toolUses: [] }

const turnEnd = (more: object = {}) =>
  ({ turnId: 't1', reason: 'answer', text: '', answer: '', durationMs: 1, isAborted: false, ...more }) as never
const answered = turnEnd()

test('past the level, Claude is told once to wrap up, not to stop', async ($, on) => {
  on('ui.toast', () => ({ value: undefined }) as never)
  atContext(on, 70)
  on('tool.call', () => ({ result: 'ok' }) as never)
  const first = await read($)
  expect(first).toContain('Do not stop mid-task')
  expect(first).toContain('compacted once')
  expect(first).not.toContain('Hand off now')
  expect(await read($)).not.toContain('Do not stop mid-task')
})

test('the token count counts too, whichever comes first', async ($, on) => {
  atContext(on, 20, 320_000)
  on('tool.call', () => ({ result: 'ok' }) as never)
  expect(await read($)).toContain('Do not stop mid-task')
})

test('past the critical point, Claude is told to hand off mid-turn', async ($, on) => {
  on('ui.toast', () => ({ value: undefined }) as never)
  atContext(on, 92)
  on('tool.call', () => ({ result: 'ok' }) as never)
  expect(await read($)).toContain('Hand off now')
})

test('nothing happens when both levels are off', { options: { handoffAt: 0, handoffTokens: 0 } }, async ($, on) => {
  atContext(on, 99)
  on('tool.call', () => ({ result: 'ok' }) as never)
  expect(await read($)).not.toContain('usage-pacer] Context')
})

test('at the end of a turn: compact the first time, ask for the handoff the next', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.toast', () => ({ value: undefined }) as never)
  atContext(on, 70)
  const compacts: unknown[] = []
  const prompts: string[] = []
  on('turn.complete', () => ({ text: '' }) as never)
  on('session.compact', (_$, e) => {
    compacts.push((e as { instructions?: string }).instructions)
    return { messages: [SUMMARY] } as never
  })
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text } as never
  })
  await $.turn.complete(answered)
  await clock.advance(10)
  expect(compacts).toHaveLength(1)
  expect(String(compacts[0])).toContain('task in progress')
  expect(prompts).toHaveLength(0)
  await $.turn.complete(answered)
  await clock.advance(10)
  expect(compacts).toHaveLength(1)
  expect(prompts.join()).toContain('Write the handoff now')
  // Asked once: a later turn end does not ask again.
  await $.turn.complete(answered)
  await clock.advance(10)
  expect(prompts).toHaveLength(1)
})

test('an interrupted turn, a subagent, or a turn below the level changes nothing', async ($, on) => {
  const clock = mock.clock(on)
  let percent = 70
  on('session.usage', () => ({ value: { ...USAGE, context: { tokens: 1, window: 1_000_000, percent, isAutoCompactEnabled: true } } }) as never)
  let compacts = 0
  on('turn.complete', () => ({ text: '' }) as never)
  on('session.compact', () => (compacts++, { messages: [SUMMARY] }) as never)
  await $.turn.complete(turnEnd({ reason: 'aborted', isAborted: true }))
  await $.turn.complete(turnEnd({ agentId: 'a1' }))
  percent = 10
  await $.turn.complete(answered)
  await clock.advance(10)
  expect(compacts).toBe(0)
})

test('without compactFirst, the first turn end asks for the handoff', { options: { compactFirst: false } }, async ($, on) => {
  const clock = mock.clock(on)
  on('ui.toast', () => ({ value: undefined }) as never)
  atContext(on, 70)
  const prompts: string[] = []
  on('turn.complete', () => ({ text: '' }) as never)
  on('prompt.submit', (_$, e) => (prompts.push(e.text), { text: e.text }) as never)
  await $.turn.complete(answered)
  await clock.advance(10)
  expect(prompts.join()).toContain('Write the handoff now')
})

test('the handoff tool saves the note, clears, and starts the fresh agent', async ($, on) => {
  atContext(on, 80)
  const writes: string[] = []
  const steps: string[] = []
  const clock = mock.clock(on, { now: Date.parse('2030-01-01T00:00:00Z') })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('fs.write', (_$, e) => {
    writes.push(String((e as { path: string }).path))
    return { value: undefined } as never
  })
  on('command.run', (_$, e) => {
    steps.push(`/${(e as { command: string }).command}`)
    return { text: '' } as never
  })
  on('prompt.submit', (_$, e) => {
    steps.push(e.text)
    return { text: e.text } as never
  })
  const r = await $.tool.call({ tool: 'mcp__usage-pacer__handoff', summary: 'Goal: ship v2. Remaining: tests.' } as never)
  expect(JSON.stringify(r)).toContain('Handoff saved to')
  expect(writes.join()).toContain('.claude/handoffs/handoff-2030-01-01T00-00-00-000Z.md')
  await clock.advance(10)
  expect(steps[0]).toBe('/clear')
  expect(steps[1]).toContain('Goal: ship v2. Remaining: tests.')
})

test('/handoff-at sets percent and tokens together, and off', async ($, on) => {
  const sets: { key: string; value: unknown }[] = []
  on('config.set', (_$, e) => {
    sets.push(e as never)
    return { value: (e as { value: unknown }).value } as never
  })
  const shown = await $.command.run({ command: 'handoff-at' } as never)
  expect(shown.text ?? '').toContain('65% context or 300k tokens')
  const both = await $.command.run({ command: 'handoff-at', args: '40% 1.2m' } as never)
  expect(both.text ?? '').toContain('40% context or 1.2M tokens')
  expect(sets.map(x => [x.key, x.value])).toEqual([
    ['usage-pacer.handoffAt', 40],
    ['usage-pacer.handoffTokens', 1_200_000],
  ])
  const off = await $.command.run({ command: 'handoff-at', args: 'off' } as never)
  expect(off.text).toBe('Handoff is off.')
  const bad = await $.command.run({ command: 'handoff-at', args: '150%' } as never)
  expect(bad.text ?? '').toContain('is not a level')
})

test('set_handoff_level changes tokens and compactFirst from chat', async ($, on) => {
  on('config.set', (_$, e) => ({ value: (e as { value: unknown }).value }) as never)
  const r = await $.tool.call({ tool: 'mcp__usage-pacer__set_handoff_level', tokens: 250_000, compactFirst: false } as never)
  expect(JSON.stringify(r)).toContain('65% context or 250k tokens')
  expect(JSON.stringify(r)).toContain('hands off')
})
