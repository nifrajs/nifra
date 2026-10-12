---
"@nifrajs/web": patch
"@nifrajs/web-solid": patch
---

When a Solid `<ErrorBoundary>` catches during server rendering, or a resource fails, the page no longer ships the error's message and stack in its inline hydration script. On Bun, that also included the server file path. The browser now receives `Error("Internal Server Error")`. In development and test the error keeps its text. That inline script now also carries the document's CSP nonce on pages rendered in one pass: `RenderAdapter.renderToString` receives `{ nonce }` as `renderToStream` already did. Before, a strict CSP blocked the script and hydration did not match the server's markup.
