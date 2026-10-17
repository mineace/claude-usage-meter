import { expect, mock, test } from 'claude-code/testing'
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

const atContext = (on: On, percent: number) => {
  on('session.usage', () => ({
    value: { ...USAGE, rateLimits: [], context: { tokens: percent * 2000, window: 200_000, percent, isAutoCompactEnabled: true } },
  }) as never)
}

test('a tool result asks for a handoff once the context reaches the level', async ($, on) => {
  atContext(on, 80)
  on('tool.call', () => ({ result: 'ok' }) as never)
  const first = await $.tool.call({ tool: 'Read', file_path: 'a.md' } as never)
  expect(JSON.stringify(first)).toContain('mcp__usage-pacer__handoff')
  const second = await $.tool.call({ tool: 'Read', file_path: 'a.md' } as never)
  expect(JSON.stringify(second)).not.toContain('Hand off now')
})

test('no handoff request below the level, or when turned off', { options: { handoffAt: 0 } }, async ($, on) => {
  atContext(on, 99)
  on('tool.call', () => ({ result: 'ok' }) as never)
  const r = await $.tool.call({ tool: 'Read', file_path: 'a.md' } as never)
  expect(JSON.stringify(r)).not.toContain('Hand off now')
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

test('/handoff-at stores the level and the new level takes effect', async ($, on) => {
  const sets: unknown[] = []
  on('config.set', (_$, e) => {
    sets.push(e)
    return { value: (e as { value: unknown }).value } as never
  })
  atContext(on, 65)
  on('tool.call', () => ({ result: 'ok' }) as never)
  const shown = await $.command.run({ command: 'handoff-at' } as never)
  expect(shown.text ?? '').toContain('75%')
  const set = await $.command.run({ command: 'handoff-at', args: '60%' } as never)
  expect(set.text).toBe('Handoff is set to 60% context.')
  expect(sets).toEqual([expect.objectContaining({ key: 'usage-pacer.handoffAt', value: 60 })])
  const r = await $.tool.call({ tool: 'Read', file_path: 'a.md' } as never)
  expect(JSON.stringify(r)).toContain('Hand off now')
})

test('set_handoff_level turns handoff off, and bad input is refused', async ($, on) => {
  on('config.set', (_$, e) => ({ value: (e as { value: unknown }).value }) as never)
  const off = await $.tool.call({ tool: 'mcp__usage-pacer__set_handoff_level', percent: 0 } as never)
  expect(JSON.stringify(off)).toContain('Handoff is off.')
  const bad = await $.command.run({ command: 'handoff-at', args: '150' } as never)
  expect(bad.text ?? '').toContain('is not a level')
})
