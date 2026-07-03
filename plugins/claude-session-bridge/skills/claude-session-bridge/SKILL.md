---
name: claude-session-bridge
description: Inspect and bridge local Claude Code sessions from Codex through safe MCP tools.
---

# Claude Session Bridge

Use this skill when the user asks Codex to inspect, list, archive, alias, resume, or visually monitor local Claude Code sessions.

## Safety Model

- Treat `~/.claude/projects/**/*.jsonl` as Claude-owned append-only history. Do not edit it.
- Store archive state and aliases in the Codex-side overlay at `~/.codex/claude-session-bridge/overlay.json`.
- Use `claude agents --json` for active/background session status.
- Use `claude_session_resume_background` with `dryRun: true` unless the user explicitly asks to launch Claude Code.
- Use `claude_session_start_background` with `dryRun: true` for new background sessions unless the user explicitly asks to launch Claude Code.
- Plugin-launched Claude commands default to `--dangerously-skip-permissions`; use them only for trusted local workspaces.
- Terminal links are local `http://127.0.0.1` links with a per-process token. Clicking one opens macOS Terminal and runs `claude --resume` or a fresh `claude --bg` command with full access.

## Tool Routing

- Open the local UI: `claude_bridge_view`.
- List recent Claude transcripts: `claude_sessions_list`.
- Read metadata or bounded message previews: `claude_session_read`.
- Generate a clickable Terminal link: `claude_session_terminal_link`.
- Hide or restore sessions in Codex views: `claude_session_archive` / `claude_session_unarchive`.
- Rename in Codex views: `claude_session_set_alias`.
- List background Claude agents: `claude_background_agents_list`.
- Prepare or launch a background resume: `claude_session_resume_background`.
- Prepare or launch a fresh background session: `claude_session_start_background`.

## Views

**Working**: Background Claude Code agents whose CLI status is not terminal.
_Avoid_: inferring Working only from transcript modification time.

**Complete**: Claude transcripts without a currently working background agent, plus background agents with terminal statuses.
_Avoid_: archived, unless the user explicitly asks for archived overlay entries.

## Terms

**Claude transcript**: A Claude Code JSONL history file under `~/.claude/projects`.
_Avoid_: Codex thread, unless it has been imported into Codex.

**Bridge overlay**: Codex-owned metadata for Claude transcripts, including aliases and archive state.
_Avoid_: Claude archive, because Claude's source files are not changed.

**Background agent**: A running or completed Claude Code background session visible through `claude agents`.
_Avoid_: Transcript, because background state is reported by the Claude CLI.

**Terminal link**: A local bridge URL that opens Terminal to resume a Claude session.
_Avoid_: remote URL, because the link depends on the local MCP process.
