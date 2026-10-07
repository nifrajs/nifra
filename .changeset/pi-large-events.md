---
"@nifrajs/pi": patch
---

fix(pi): a Pi turn whose reply, tool output, tool arguments, or streamed text is past what one event may carry completes, instead of failing with `PI_PROTOCOL`. A long reply or stream arrives as consecutive events that join back to the text; `tool.started` and `tool.completed` carry bounded display copies (a tool output past 64 KiB used to fail the turn). NUL in a prompt or in Pi's text no longer fails the turn.
