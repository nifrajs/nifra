---
"@nifrajs/core": major
---

WebSocket routes are now enabled with `.use(websocket())` from `@nifrajs/core/ws`, matching every other opt-in system. The old `import "@nifrajs/core/ws"` side-effect no longer installs the runtime.

The runtime installs on that server instance only (no process-global), so `app.ws()` without the plugin fails loudly at registration. Adapters and `@nifrajs/workers` still import `attachWebSocket` / `TopicRegistry` from the same subpath.

```ts
// before
import "@nifrajs/core/ws"
const app = server().ws("/chat", handler)

// after
import { websocket } from "@nifrajs/core/ws"
const app = server().use(websocket()).ws("/chat", handler)
```
