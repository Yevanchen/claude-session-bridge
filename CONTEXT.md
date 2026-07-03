# Claude Session Bridge

Claude Session Bridge makes Claude Code's local sessions visible and resumable from Codex without taking ownership of Claude Code's storage or lifecycle.

## Language

**Claude Code Session**:
A durable Claude Code conversation identified by a session id and usually backed by a JSONL transcript.
_Avoid_: Thread, chat

**Codex Thread**:
A Codex-owned workspace conversation managed by the Codex app thread tools.
_Avoid_: Claude session

**Transcript**:
A Claude-owned JSONL file under `~/.claude/projects` that records a Claude Code session.
_Avoid_: Database, state store

**Background Agent**:
A Claude Code session launched or listed through `claude --bg` and `claude agents`.
_Avoid_: Worker, thread

**Bridge Overlay**:
Codex-owned metadata for Claude Code sessions, such as aliases and archive state, stored outside Claude's transcript directory.
_Avoid_: Claude metadata, transcript patch

**Terminal Link**:
A localhost URL with a per-process token that opens macOS Terminal and runs a Claude CLI command.
_Avoid_: Remote link, shared link

**Marketplace**:
A Codex plugin catalog that points to the installable plugin directory.
_Avoid_: Package registry
