# defrag

Tells a coding agent's user when compacting is safe: at the quiet point between
tasks, not when the context window is nearly full.

Targets Claude Code, Codex, OpenCode (including OpenChamber), Cursor, and
oh-my-pi. The first judge is TypeSafe Jev; judges and rules are compared on
replayed real checkpoints and replaced when a measurement shows a gain.

Status: early. No adapters ship yet.
