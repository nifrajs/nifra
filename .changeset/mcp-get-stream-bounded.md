---
"@nifrajs/mcp": patch
---

The HTTP transport no longer opens its GET server-message stream for a caller it has not checked. With `authorizeMessage` set, a GET that asks for `text/event-stream` is now answered `405` (the Streamable HTTP answer for "no stream offered here"), since that stream carries no message the callback could authorize; before, any caller could open one and hold it with keep-alive comments. Without `authorizeMessage`, the stream now closes after five minutes, and a client that wants it again reconnects. Nothing is sent on this stream, so no message is lost; tool calls and their progress still travel on the POST stream.
