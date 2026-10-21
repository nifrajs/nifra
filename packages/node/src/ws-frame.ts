/**
 * The Node WebSocket publish fast path: one pre-built text frame for every idle subscriber, written
 * past `ws`'s own sender.
 */
import { Socket } from "node:net"

/** The last text framed, and its frame: a publish hands every subscriber the same string. */
let framedText: string | undefined
let framedBytes: Buffer | undefined

/** An unmasked, final text frame (RFC 6455 5.2), as a server sends one. */
export function textFrame(text: string): Buffer {
  if (text === framedText && framedBytes !== undefined) return framedBytes
  const body = Buffer.from(text)
  const length = body.length
  const head = length < 126 ? 2 : length < 65_536 ? 4 : 10
  const frame = Buffer.allocUnsafe(head + length)
  frame[0] = 0x81
  if (length < 126) frame[1] = length
  else if (length < 65_536) {
    frame[1] = 126
    frame.writeUInt16BE(length, 2)
  } else {
    frame[1] = 127
    frame.writeBigUInt64BE(BigInt(length), 2)
  }
  body.copy(frame, head)
  framedText = text
  framedBytes = frame
  return frame
}

/**
 * Write `text` as one pre-built frame straight to the socket, the same bytes for every subscriber of a
 * publish, so a fan-out frames once instead of once per socket. Only while `ws`'s own sender is idle:
 * anything it has queued must go first. Returns false to leave the send to `ws`.
 */
export function writeTextFrame(ws: { readonly readyState: number }, text: string): boolean {
  if (ws.readyState !== 1) return false
  const sender: unknown = Reflect.get(ws, "_sender")
  const socket: unknown = Reflect.get(ws, "_socket")
  if (
    typeof sender !== "object" ||
    sender === null ||
    Reflect.get(sender, "_state") !== 0 ||
    !Array.isArray(Reflect.get(sender, "_queue")) ||
    Reflect.get(sender, "_queue").length !== 0 ||
    !(socket instanceof Socket) ||
    socket.destroyed
  ) {
    return false
  }
  socket.write(textFrame(text))
  return true
}
