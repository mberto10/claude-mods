# Changelog

## 0.1.1 · 2026-10-03

- The suggestions above the prompt now stack with lines other mods draw there instead of hiding them: while Next up is thinking or showing steps, another mod's line stays visible below.

## 0.1.0 · 2026-10-02

First public release.

- Up to three next prompts above the prompt box when a turn ends, from the conversation, open GitHub issues and pull requests (`gh`) and your open Linear issues (Linear MCP server).
- Modes: `mixed`, `linear`, `github` and `conversation`, set in the settings or per project with `/next mode`.
- Criteria per project in `.claude/next-up.json`: Linear projects, team, labels, state types, assignee and query; GitHub labels, assignee and items. Set with `/next linear …` and `/next github …`, shown with `/next config`.
- Linear issues ordered by state, then priority, before ranking; one step per source in `mixed` mode; a short reason on each step.
- Time limits on sources and the ranker, and a reset on load, so the band never stays on "thinking".
- A light ranker by default: a small model reads the last exchange and a capped list of open items, never the transcript. A `fork` ranker over the cached transcript is optional and falls back to the light one.
- Type a number and Enter to send a step, or click it to edit it first; `/next`, `/next refresh` and `/next sources`, which names why a source returned nothing.
- A one-time reminder when the Linear tool is not allowed in your permissions.
