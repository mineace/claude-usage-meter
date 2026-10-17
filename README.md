# usage-pacer

A small Claude Code plugin that lets Claude read your usage so it plans its work accordingly.

> No guarantee that it'll work for you.

- **Every prompt** carries a one-line note, e.g. `5-hour limit 50% · 7-day limit 37% · context 10% · $1.06`, plus advice once plan usage passes 75% or context passes 80%.
- **`get_usage` tool** (`mcp__usage-pacer__get_usage`): Claude can call it for the full picture: percent used and reset time for each rate-limit window, context-window fill, session cost and session age.
- **Wind-down before the limit**: when the 5-hour or 7-day window crosses 95% (and again at 98%), the next tool result tells Claude to stop starting new steps, save or commit its work, and hand you a summary of what is done and what remains. This reaches Claude mid-turn, not only on your next prompt.
- **Handoff before the context fills, without interrupting work**. The level is a context percentage or a token count, whichever comes first (default **65% or 300k tokens**). Once it is passed:
  1. Mid-turn, Claude is told once to finish what it is doing and stop at a natural point, not to drop the task.
  2. When that turn ends, the conversation is **compacted once**, keeping the task in progress, so the work carries on with room to spare. A compaction from anywhere else (auto-compact, `/compact`) counts as this one. If the compaction cannot run or is refused, it is retried rather than skipped. Subagents get none of these notices: their context is their own.
  3. The next time the level is passed, at the end of a turn Claude is asked to write a handoff and call `mcp__usage-pacer__handoff`. The handoff is saved to `.claude/handoffs/handoff-<time>.md` in your project, the conversation is cleared, and a fresh agent in the same session and folder continues from it.
  4. Safety net: if a single turn runs to 90% of the window (or twice the token level), Claude is told to hand off mid-turn rather than wait.

  Change it from any Claude Code app: `/handoff-at 40%`, `/handoff-at 300k`, `/handoff-at 40% 300k`, `/handoff-at off` (alone, it shows the current setting); or ask Claude in chat ("hand off at 250k tokens", "skip the compaction step"); or in the terminal under `/config` (`usage-pacer`). Settings are saved and apply to later sessions. You may want `.claude/handoffs/` in your `.gitignore`.
- **Status line** with the same summary, and a toast when a window crosses 75% and 90%.

Plan limits (5-hour / 7-day) are reported only on a Claude subscription, and only after the session's first response. On API billing you get context and cost.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install usage-pacer --marketplace mineace/claude-usage-meter
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install usage-pacer --marketplace mineace/claude-usage-meter
```

In the desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `mineace/claude-usage-meter` → **Add plugin**.

## Develop

```
claude plugin validate .
claude plugin test .
```
