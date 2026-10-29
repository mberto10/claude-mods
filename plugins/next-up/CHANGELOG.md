# Changelog

## 0.3.0 · 2026-10-29

Steps when they are likely to help, and fewer small model requests. No new setting or command.

- Steps only after a turn that changed something: the main loop edited a file, ran a shell command or called an MCP tool that creates or updates something. Not after a turn that only read or answered, and not after a subagent's turn.
- The small model is not called after an answer under 200 characters, an answer that ends in a question to you, or while a usage limit window is at 90% or more. Each finished answer now costs at most one request, and often none.
- After three sets of steps in a row go unused, steps come only on every third eligible answer, until you use one or run `/next refresh`. `/next refresh` always picks steps.
- Each step is tagged with its kind in the band: `continue`, `verify`, `ship` or `issue`. No two steps share a kind, except `issue`.
- `/next sources` shows how many steps you used, dismissed or ignored, for this session and for all sessions. The counts stay in the plugin's own store and are never sent anywhere.
- The README and descriptions lead with steps from your Linear issues or GitHub issues and pull requests; `conversation` mode stays the default, which needs no setup. The README says how it relates to Claude Code's built-in prompt suggestion and how to turn either off.

## 0.2.0 · 2026-10-29

Fewer moving parts: one source per mode, two settings and no file in your repository. If you used 0.1.x:

- `mixed` mode is removed. Pick `linear`, `github` or `conversation`. The default is now `conversation`, which needs no setup.
- `/next mode <name>` switches for the current session only and writes no file; the Mode setting is where each session starts.
- The `fork` ranker and the Ranker and Light ranker model settings are removed. A small model (Haiku) always picks the steps from the last exchange and a short list of items.
- `.claude/next-up.json` and the commands `/next linear …`, `/next github …` and `/next config` are removed. Use the Mode and Linear project settings instead; the file is no longer read and can be deleted.
- The GitHub items, Items per source and Linear server settings are removed, with fixed defaults: GitHub issues and pull requests, 12 items per source, and the Linear connector found by its `list_issues` tool.
- New rules for picking steps: no padding to three, nothing when nothing fits the current work, and `conversation` steps that differ from one another.
- Shorter README, settings and plugin descriptions.
- Fix: a typed number sends the row the band shows, even when the stored steps changed after it was drawn, and slash commands such as `/next` keep the steps instead of clearing them.
- Fix: in the desktop app, typing `0` and Enter to dismiss the steps no longer sends a `0` to Claude; a draft you typed stays in the box when you click dismiss.

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
