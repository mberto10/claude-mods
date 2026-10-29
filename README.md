# Claude mods

Mods for [Claude Code](https://claude.com/claude-code): plugins that change the interface itself, such as a band above the prompt or a pane beside the conversation. Each one is installed from this repository, which is also a plugin marketplace.

## Mods

| Mod | What it does | Version |
|---|---|---|
| [Next up](plugins/next-up/) | Up to three next prompts above the prompt box from your open Linear issues or GitHub issues and pull requests, after a turn that changed something; with no setup, continuations of the conversation. | 0.3.0 |
| [Linear tree](plugins/linear-tree/) | A Linear project as a tree and a flowchart in a side pane, with progress, search, shortcuts and markers on the issues agents are working on. | 0.1.1 |

## Install

```text
/plugin marketplace add mberto10/claude-mods
/plugin install next-up@claude-mods
/plugin install linear-tree@claude-mods
```

Both need Claude Code 2.1.287 or later. Start a new session afterwards. Each mod's README covers its own setup.

## Layout

```text
plugins/<name>/                    one folder per mod, with its own README, CHANGELOG and LICENSE
.claude-plugin/marketplace.json    the marketplace
```

Questions and problems: [open an issue](https://github.com/mberto10/claude-mods/issues).

Working systems from the Applied Attention articles, such as Attention Diet, live in [applied-systems](https://github.com/mberto10/applied-systems).

## License

[MIT](LICENSE).
