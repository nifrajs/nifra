/**
 * A second browsing context for `query-identity-boundary.test.ts`: a worker with its own globals, its
 * own query client and its own identity module, talking to the test only over the shared
 * `BroadcastChannel` name, as another tab would.
 */
import { IDENTITY_CHANNEL, identityChanged } from "../src/identity.ts"
import { createQueryClient } from "../src/query.ts"

Reflect.set(globalThis, "window", globalThis)

const client = createQueryClient({ now: () => 0 })
client.setQueryData(["profile"], "previous visitor")
let heard = 0
const probe = new BroadcastChannel(IDENTITY_CHANNEL)
probe.onmessage = () => {
  heard++
}

self.onmessage = (event: MessageEvent) => {
  // Worker messages have an empty origin in Bun; when present, allow only the worker's own origin.
  if (event.origin !== "" && event.origin !== self.location.origin) return
  if (event.data === "report")
    postMessage({ profile: client.getQueryData(["profile"]) ?? null, heard })
  else if (event.data === "change") identityChanged()
}
postMessage("ready")
