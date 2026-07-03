# Keep Claude Files Read-Only

Claude Session Bridge reads Claude Code transcripts and CLI agent state, but stores all bridge-specific metadata in a separate Codex overlay. This keeps Claude Code as the owner of its sessions while still letting Codex provide views, archive labels, aliases, and Terminal resume links. The alternative was to mutate or normalize Claude's transcript files, but that would make the bridge fragile against Claude Code updates and harder to trust.
