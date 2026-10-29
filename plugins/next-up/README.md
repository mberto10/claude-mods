# Next up

A Claude Code mod that answers "what now?". When Claude finishes an answer, up to three next prompts appear above the prompt box: continuations of what you just did, your open GitHub issues and pull requests, or your Linear issues, depending on the mode. Type a number to send one.

```text
Next up (conversation) · type a number and Enter to send it, or click one to edit it first
continue  1: Handle CRLF in the writer too       same bug, second file
verify    2: Run the parser tests                checks the fix
ship      3: Commit and open a pull request      the work is finished
dismiss
```

Mods are Claude Code plugins that change the interface itself; this one draws a band above the prompt. Their API is new and may change between Claude Code releases.

## Quick start

1. **Install** (Claude Code 2.1.287 or later):

   ```text
   /plugin marketplace add mberto10/claude-mods
   /plugin install next-up@claude-mods
   ```

2. **Pick a mode.** It starts in `conversation` mode, which needs no setup. Choose another in the plugin's settings, or try one for the session with `/next mode github`.
3. **Allow Linear** (only for `linear` mode). The mod reads Linear in the background, where nobody can be asked, so allow the connector's read-only `list_issues` tool once in `/permissions`. In the terminal it is `mcp__claude_ai_Linear__list_issues`; in the desktop app the connector has an id, and `/next sources` names it.

## Modes

| Mode | Steps come from |
|---|---|
| `conversation` (default) | Continuations of the current work; no source is read |
| `github` | The repository's open issues and pull requests, through the `gh` CLI and your login |
| `linear` | Your open Linear issues, through the Linear connector you already have |

The Mode setting is where each session starts. `/next mode <name>` switches for the current session only. The band's header shows the mode in force.

## How steps are chosen

1. **Only after a turn that changed something.** Steps follow a finished answer from a turn that edited a file, ran a shell command or called an MCP tool that creates or updates something (`save_…`, `create_…`, `update_…`). Not after a turn that only read or answered, a question to you, an interrupted turn, a subagent's turn or an answer under 200 characters, and not while a usage limit window is at 90% or more. The small model is then not called at all. `/next refresh` picks steps whatever the last turn did.
2. **The mode's source is read** (not in `conversation` mode). GitHub: open pull requests first, then the newest issues. Linear: your open issues, in the Linear project setting when one is set, started before unstarted before backlog, then by priority. The mod finds the Linear connector by its `list_issues` tool, whatever the app calls it. Results are cached for five minutes; a source that does not answer within 20 seconds is skipped for that turn. The first 12 items go on.
3. **A small model picks the steps.** Haiku gets your last prompt and Claude's answer, each cut to 750 characters, and the items. It prefers items related to the current work and otherwise keeps the order. In `conversation` mode it writes continuations that differ from one another. Each step carries a short reason.
4. **Fewer than three, or none, is normal.** The model does not pad the list, and shows nothing when nothing fits.
5. **You choose.** Type `1`, `2` or `3` and Enter to send a step as written, or click it to edit it in the prompt box first. `0` dismisses the steps; any other prompt clears them, while a slash command such as `/next` keeps them. While steps are showing, a prompt that is only a step's number sends that step.

## Commands

| Command | What it does |
|---|---|
| `/next` | Says how many steps are showing |
| `/next refresh` | Reads the source again and picks new steps |
| `/next mode <name>` | Switches the mode for this session |
| `/next sources` | How many open items each source returned, or why none, and how many steps you used, dismissed or ignored |

## Settings

| Setting | Default | What it does |
|---|---|---|
| Mode | `conversation` | `conversation`, `github` or `linear` |
| Linear project | empty | Only issues in this project (name, identifier or slug). Empty: all your open issues |

## Cost, privacy and turning it off

Each finished answer costs one small model request, roughly 1,000 to 2,000 tokens however long the session is. The suggestions never enter the conversation; Claude's context grows only by the step you send and the one line `/next` prints. Issue titles, states, priorities and ids go to that small model. The mod writes nothing to GitHub, Linear or your repository, and a step runs only when you send it, under your normal permissions.

Each set of steps ends as used (you sent one), dismissed (`0` or the dismiss button) or ignored (you sent your own prompt, or new steps replaced it). The mod counts these for the session in memory and for all sessions in its own plugin store, a JSON file under your Claude Code configuration directory. `/next sources` shows both; the counts are never sent anywhere.

To turn the mod off, run `/plugin disable next-up@claude-mods`, or set `"next-up@claude-mods": false` under `enabledPlugins` in your settings.

Claude Code has its own prompt suggestions, which can appear in the prompt box alongside `conversation` mode. Set `"promptSuggestionEnabled": false` in your settings to turn those off.

## Troubleshooting

`/next sources` names the reason when a source returns nothing:

| It says | Do this |
|---|---|
| `requested permissions to use mcp__…__list_issues` | Allow that tool in `/permissions`; a new session picks it up |
| `no connected MCP tool "list_issues"` | Connect the Linear connector |
| `gh failed: …` | Run `gh auth login`, and start Claude Code inside a GitHub repository |
| `no answer within 20s` | The source was slow; `/next refresh` tries again |
| `off in this mode` | The mode does not read that source; switch with `/next mode github` or `/next mode linear` |

## Development

`claude plugin test plugins/next-up` runs the tests; `claude --plugin-dir plugins/next-up` starts a session with the mod loaded from disk.

## License

[MIT](LICENSE).
