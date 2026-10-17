# usage-pacer

A small Claude Code plugin that lets Claude read your usage so it plans its work accordingly.

> No guarantee that it'll work for you.

- **Every prompt** carries a one-line note, e.g. `5-hour limit 50% · 7-day limit 37% · context 10% · $1.06`, plus advice once plan usage passes 75% or context passes 80%.
- **`get_usage` tool** (`mcp__usage-pacer__get_usage`): Claude can call it for the full picture: percent used and reset time for each rate-limit window, context-window fill, session cost and session age.
- **Wind-down before the limit**: when the 5-hour or 7-day window crosses 95% (and again at 98%), the next tool result tells Claude to stop starting new steps, save or commit its work, and hand you a summary of what is done and what remains. This reaches Claude mid-turn, not only on your next prompt.
- **Handoff before the context fills**: when the context window reaches 75% (configurable), Claude is told to finish the step in progress and call `mcp__usage-pacer__handoff` with a full handoff. The handoff is saved to `.claude/handoffs/handoff-<time>.md` in your project, the conversation is cleared when the turn ends, and a fresh agent in the same session and folder continues from the handoff. Change the level from any Claude Code app: type `/handoff-at 60` (or `/handoff-at off`; `/handoff-at` alone shows it), ask Claude in chat ("set the handoff to 60%"), or in the terminal use `/config` (`usage-pacer` → *Hand off at context %*). The level is saved in your settings and applies to later sessions too. You may want `.claude/handoffs/` in your `.gitignore`.
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
