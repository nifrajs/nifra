import { connect } from "node:net"

/** One raw HTTP exchange: write `request`, collect everything until the server closes or `until` matches. */
export function raw(
  port: number,
  request: string | Buffer,
  until: (received: string) => boolean = () => false,
  timeoutMs = 2000,
): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(request))
    let received = ""
    const done = (): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(received)
    }
    const timer = setTimeout(done, timeoutMs)
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1")
      if (until(received)) done()
    })
    socket.on("close", done)
    socket.on("error", done)
  })
}

/** Parse the head of a raw response: status line and a lowercase header multimap. */
export function parseHead(text: string): {
  status: number
  headers: Map<string, string[]>
  body: string
} {
  const split = text.indexOf("\r\n\r\n")
  const head = split === -1 ? text : text.slice(0, split)
  const body = split === -1 ? "" : text.slice(split + 4)
  const [line, ...rest] = head.split("\r\n")
  const headers = new Map<string, string[]>()
  for (const entry of rest) {
    const colon = entry.indexOf(":")
    if (colon === -1) continue
    const name = entry.slice(0, colon).toLowerCase()
    const list = headers.get(name) ?? []
    list.push(entry.slice(colon + 1).trim())
    headers.set(name, list)
  }
  return { status: Number(line?.split(" ")[1]), headers, body }
}

export const AUTH = "Bearer abcdefghijklmnopqrstuvwxyz"

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))
