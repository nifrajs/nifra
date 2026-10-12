/**
 * One outbound-contract check for a `validateSend` socket, run over a real socket on every runtime
 * nifra serves: a frame the route's `sendSchema` refuses never reaches the client, and the route's
 * `error()` hears about it. The file imports nothing: each suite builds the app from its own `server`.
 */

/** The part of `server().use(websocket())` the fixture uses. */
interface WsRoutable {
  ws(path: string, handler: object): unknown
}

interface ContractSocket {
  send(data: string): void
}

export const SEND_CONTRACT_PATH = "/send-contract"

const onlyOk = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) =>
      typeof value === "object" && value !== null && "ok" in value && value.ok === true
        ? { value }
        : { issues: [{ message: "expected { ok: true }" }] },
  },
}

/** Registers the contract socket on `app`. Its `open` sends a refused frame, then an accepted one. */
export function sendContractApp<App extends WsRoutable>(
  app: App,
): { readonly app: App; readonly errors: unknown[] } {
  const errors: unknown[] = []
  app.ws(SEND_CONTRACT_PATH, {
    sendSchema: onlyOk,
    validateSend: true,
    open: (ws: ContractSocket) => {
      ws.send(JSON.stringify({ leaked: true }))
      ws.send(JSON.stringify({ ok: true }))
    },
    error: (_ws: unknown, error: unknown) => {
      errors.push(error)
    },
  })
  return { app, errors }
}

/** The first frame the client receives from the contract socket. */
export function firstContractFrame(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${SEND_CONTRACT_PATH}`)
    const timer = setTimeout(() => reject(new Error("no frame arrived")), 5000)
    socket.addEventListener("message", (event) => {
      clearTimeout(timer)
      socket.close()
      resolve(String(event.data))
    })
    socket.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("socket errored"))
    })
  })
}
