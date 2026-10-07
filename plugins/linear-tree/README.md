# Linear tree

A Claude Code mod that shows a Linear project in a side pane: milestones, issues and sub-issues as a tree, or as a flowchart, with progress over everything under each node. Select an issue and send it to Claude as the next prompt.

```text
Website                                   − list +
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  12/31
[ Search            ]  Shortcuts ▾  [ Open ▾ ]

▾ ◔ October  2026-10-31                    5/9
  ├─ ◐ ENG-12 Checkout redesign       ▮▮▯  2/4
  │  ├─ ✔ ENG-14 Payment form
  │  └─ ○ ENG-15 Address autocomplete  ● researcher
  └─ ○ ENG-18 Onboarding copy
▸ ◔ November  2026-11-30                   0/6
```

Mods are Claude Code plugins that change the interface itself. This one opens a pane and reads Linear; it never writes to it.

## Quick start

1. **Install** (Claude Code 2.1.287 or later):

   ```text
   /plugin marketplace add mberto10/applied-systems
   /plugin install linear-tree@applied-systems
   ```

2. **Allow Linear.** The mod reads Linear in the background, where nobody can be asked, so allow the connector's read-only `list_issues` tool once in `/permissions`, and `list_milestones` for milestone order and dates. In the terminal they are `mcp__claude_ai_Linear__list_issues` and `mcp__claude_ai_Linear__list_milestones`; in the desktop app the connector has an id, and a refused call names it in the pane.
3. **Open a project:**

   ```text
   /tree Website
   ```

## Commands

| Command | Effect |
|---|---|
| `/tree <project>` | Opens the project in the side pane and remembers it |
| `/tree` | Opens the last project again |
| `/tree sort work\|priority\|updated\|id` | Orders siblings: working order (state, then priority), priority, recently updated or id |
| `/tree milestone <name>\|all` | Shows one milestone or all |
| `/tree collapse` · `/tree expand` · `/tree refresh` | Folds everything, unfolds everything, reloads now |
| `/flow` | Opens the pane as a flowchart of every milestone |
| `/flow <milestone>` | The flowchart of one milestone |

## Views

The − / + control at the top right steps through four views: **list**, then the flowchart at **overview**, **normal** and **detail**. Detail draws large cards with the start of each description. The flowchart needs the desktop app; the terminal shows the list.

The list has a search over id, title and assignee (a match keeps its path open), a filter for open, in progress or all issues, and an arrow on every node to fold it.

## Working with issues

- **Click** an issue to select it, **double-click** it to put `Work on ENG-12: <title> (<url>)` in the prompt box. If the prompt box does not take it, the text goes to the clipboard.
- **Details** (`d`) opens a second pane with the whole description, a link to Linear and a Work on it button.
- **Shortcuts** open from the Shortcuts button; the keys work while it is closed:

| Key | Action |
|---|---|
| `j` · `k` | Next and previous issue |
| `h` · `l` | Fold and unfold (list) |
| `s` · `f` | Search, cycle the filter (list) |
| `o` | Work on the selected issue |
| `d` | Details |
| `v` | Switch between list and flowchart |
| `r` | Refresh |
| `0` to `3` | List, overview, normal, detail (flowchart) |

## Agents at work

When a prompt or a subagent's task names an issue id, that issue gets a pulsing marker with the agent's name until its turn ends, and the header counts the agents at work. Nothing is sent anywhere; the mod reads the ids from the prompt and the task text.

## What it keeps

Per project, across sessions: the view, filter, sort, zoom, folds, milestone and selection, restored once per session. The tree reloads every five minutes while the pane is open.

## Settings

`/plugin configure linear-tree@applied-systems`:

| Setting | Default |
|---|---|
| Default project | Empty: the last project shown, else the first project in `.claude/next-up.json` |
| Linear server | Empty: the connector whose `list_issues` tool is Linear's, found by itself |
| Refresh every (minutes) | 5; 0 turns it off |

## Limits

- Read-only: no status changes or moves in Linear.
- Flowchart cards are a picture, so they are not clickable; select with `j`/`k` or in the list.
- Up to 1,000 issues per project, loaded 50 at a time.

## License

[MIT](LICENSE).
