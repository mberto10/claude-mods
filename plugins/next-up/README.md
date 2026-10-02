# Next up

A Claude Code mod that answers "what now?". When a turn ends, up to three next prompts appear above the prompt box: a continuation of what you just did, or the open GitHub issue, pull request or Linear issue that fits it best. Type a number to send one.

```text
Next up (mixed) · type a number and Enter to send it, or click one to edit it first
1: Add tests for the anchor fix          continue · follows the fix just made
2: Review the release notes PR           #5 · touches the same module
3: Draft the onboarding copy             ENG-42 · in progress, high priority
dismiss
```

Mods are Claude Code plugins that change the interface itself; this one draws a band above the prompt and needs no setup beyond the sources you want.

## Quick start

1. **Install** (Claude Code 2.1.287 or later):

   ```text
   /plugin marketplace add mberto10/applied-systems
   /plugin install next-up@applied-systems
   ```

2. **Allow Linear** (skip if you only use GitHub). The mod reads Linear in the background, where nobody can be asked, so allow the connector's read-only `list_issues` tool once in `/permissions`. In the terminal it is `mcp__claude_ai_Linear__list_issues`; in the desktop app the connector has an id, and `/next sources` names it.
3. **Point it at your work**, once per repository:

   ```text
   /next linear project Website
   /next mode linear
   ```

   `/next sources` shows what each source found.

## Modes

| Mode | Steps come from |
|---|---|
| `mixed` (default) | One continuation, one GitHub item and one Linear item |
| `linear` | Your open Linear issues only |
| `github` | The repository's open issues and pull requests only |
| `conversation` | Continuations of the current work only; no source is read |

`/next mode <name>` switches the mode for the current repository. The band's header shows it.

## Criteria per repository

Each repository keeps its own criteria in `.claude/next-up.json` at its top level. Set them with commands or edit the file; `off` clears a setting, lists are comma-separated.

| Command | Effect |
|---|---|
| `/next linear project Website, Docs` | Only these Linear projects |
| `/next linear states started,unstarted` | Only these state types (default: started, unstarted, backlog, triage) |
| `/next linear team Engineering` | Only this team |
| `/next linear label bug` | Only issues with this label |
| `/next linear assignee any` | Anyone's issues (default: `me`) |
| `/next linear query onboarding` | Title or description contains this |
| `/next github label good first issue` | Only issues and pull requests with this label |
| `/next github assignee @me` | Only those assigned to you |
| `/next github items issues` | Issues only, no pull requests |

```json
{
  "mode": "linear",
  "linear": { "projects": ["Website"], "states": ["started", "unstarted"] },
  "github": { "assignee": "@me" }
}
```

Commit the file and the whole team shares the criteria; leave it out and they stay yours.

## How steps are chosen

1. **When a turn ends** with an answer (not a question to you, not interrupted), the mod reads the sources the mode names:
   - **GitHub:** open issues and pull requests through the `gh` CLI and your existing login.
   - **Linear:** open issues through the Linear connector you already have; no API key is stored. The mod finds the connector by its `list_issues` tool, whatever the app calls it.

   Results are cached for five minutes; a source that does not answer within 20 seconds is skipped for that turn.
2. **Code orders the candidates.** Linear: started before unstarted before backlog, then urgent, high, medium, low and no priority, then the most recently updated. GitHub: pull requests first, then the newest issues. The first 12 of each source go on.
3. **A small model picks the steps.** `haiku` gets the last prompt and answer and the ordered list, and picks the items related to the current work; otherwise it keeps the order. Each step carries a short reason, shown after its id.
4. **You choose.** Type `1`, `2` or `3` and Enter to send a step as written, or click it to edit it in the prompt box first. `0` dismisses the steps; any other prompt clears them.

## Commands

| Command | What it does |
|---|---|
| `/next` | Says how many steps are showing |
| `/next refresh` | Reads the sources again and picks new steps |
| `/next mode <name>` | Switches the mode for this repository |
| `/next linear <setting> <value>` | Sets a Linear criterion |
| `/next github <setting> <value>` | Sets a GitHub criterion |
| `/next config` | Shows the criteria in force |
| `/next sources` | How many open items each source returned, or why none |

## Context and cost

The suggestions never enter the conversation. Claude's context grows only by what you send: a step is one short prompt, and `/next` answers in one line.

Picking the steps is a separate request with its own budget:

- **`light`** (default): the last prompt and answer, each cut to 750 characters, and at most 12 items per source with titles cut to 90 characters. Roughly 1,000 to 2,000 tokens to a small model, however long the session.
- **`fork`**: the session's own model over the whole cached transcript. It knows the session better, but each request is as large as the conversation. When it does not answer, for one near the context limit, the light ranker takes over.

## Settings

Plugin-wide defaults; a repository's `.claude/next-up.json` overrides mode and criteria.

| Setting | Default | What it does |
|---|---|---|
| Mode | `mixed` | `mixed`, `linear`, `github` or `conversation` |
| GitHub items | `issues-and-prs` | Or `issues` only |
| Linear server | empty | A server name as `/mcp` lists it. Empty: found by its tool, then `claude.ai Linear`, `Linear`, `linear` |
| Linear project | empty | A default project for repositories that name none |
| Ranker | `light` | `light` or `fork`, see [Context and cost](#context-and-cost) |
| Light ranker model | `haiku` | An alias or a full model id |
| Items per source | `12` | At most this many items per source reach the ranker (up to 50) |

## Troubleshooting

`/next sources` names the reason when a source returns nothing:

| It says | Do this |
|---|---|
| `requested permissions to use mcp__…__list_issues` | Allow that tool in `/permissions`; a new session picks it up |
| `no connected MCP tool "list_issues"` | Connect the Linear connector, or set the Linear server setting to its name in `/mcp` |
| `gh failed: …` | Run `gh auth login`, and start Claude Code inside a GitHub repository |
| `no answer within 20s` | The source was slow; `/next refresh` tries again |
| `off in this mode` | The mode skips that source: `/next mode mixed` |

## What it sends where

Issue titles, states, priorities and ids go to the model that picks the steps, as they would if you asked Claude to read your issues. The mod writes nothing to GitHub or Linear. It writes one file, `.claude/next-up.json`, and only when you set a criterion. A step takes effect only when you send it, and Claude then works under your normal permissions.

## Limits

- Each finished turn costs one extra small model request.
- While steps are showing, a prompt that is only `1`, `2` or `3` sends that step instead.
- Mods are new; their API may change between Claude Code releases.

## Development

```sh
claude plugin validate plugins/next-up
claude plugin test plugins/next-up
claude --plugin-dir plugins/next-up
```

The last runs a session with the mod loaded from disk; saving a file reloads it.

## License

[MIT](LICENSE).
