# Changelog

## 0.1.0 · 2026-10-07

First public release.

- A Linear project in a side pane as a tree of milestones, issues and sub-issues, with status, priority, assignee and progress over everything under each node.
- A flowchart of the same tree in the desktop app at three zoom levels; one − / + control steps from the list through overview, normal and detail.
- `/tree <project>` with `sort`, `milestone`, `collapse`, `expand` and `refresh`; `/flow` for every milestone, `/flow <milestone>` for one.
- Search over id, title and assignee, a filter for open, in progress or all issues, and folding.
- Click to select, double-click or `o` to put the issue in the prompt box (clipboard when the box does not take it); a details pane with the whole description and a link to Linear.
- Keyboard shortcuts, folded behind a Shortcuts button and working while it is closed.
- Markers on the issues the session or a subagent is working on.
- View state kept per project across sessions; a reload every five minutes while the pane is open.
- Reads Linear 50 issues at a time, up to 1,000, and says in the pane why a load failed instead of showing an empty tree.
