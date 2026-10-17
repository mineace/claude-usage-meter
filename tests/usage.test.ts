import { expect, test } from 'claude-code/testing'
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
