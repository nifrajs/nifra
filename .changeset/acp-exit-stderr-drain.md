---
"@nifrajs/acp": patch
---

The error for an ACP agent that exits now names the reason the agent wrote to stderr even when the exit is observed before that line has been read. The exit waits for stderr to end, for at most half a second in case a process the agent left behind keeps it open.
