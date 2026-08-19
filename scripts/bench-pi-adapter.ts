import { performance } from "node:perf_hooks"
import { PiBackend } from "@nifrajs/pi"

const count = Number(Bun.argv.find((arg) => arg.startsWith("--turns="))?.slice(8) ?? "100")
if (!Number.isSafeInteger(count) || count < 1 || count > 10_000)
  throw new Error("--turns must be between 1 and 10000")

const fakePi = `
let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += String(chunk)
  for (;;) {
    const newline = buffer.indexOf("\\n")
    if (newline < 0) return
    const command = JSON.parse(buffer.slice(0, newline))
    buffer = buffer.slice(newline + 1)
    if (command.type === "prompt") process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n")
  }
})
`

const directStart = performance.now()
const directProcess = Bun.spawn([process.execPath, "-e", fakePi], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "ignore",
})
const directReader = directProcess.stdout.getReader()
const decoder = new TextDecoder()
let directBuffer = ""
for (let turn = 0; turn < count; turn++) {
  directProcess.stdin.write(`${JSON.stringify({ type: "prompt", message: "ping" })}\n`)
  directProcess.stdin.flush()
  for (;;) {
    const line = await nextLine(
      directReader,
      decoder,
      () => directBuffer,
      (value) => {
        directBuffer = value
      },
    )
    if ((JSON.parse(line) as { type?: string }).type === "agent_end") break
  }
}
const directMs = performance.now() - directStart
directReader.releaseLock()
directProcess.kill()
await directProcess.exited

const adapterStart = performance.now()
const backend = new PiBackend({ command: process.execPath, rpcArgs: ["-e", fakePi] })
const session = await backend.createSession({ cwd: process.cwd(), sessionId: "bench" })
for (let turn = 0; turn < count; turn++)
  for await (const _event of backend.send({ sessionId: session.id, message: "ping" })) {
  }
await backend.close(session.id)
const adapterMs = performance.now() - adapterStart

const result = {
  turns: count,
  directMs: round(directMs),
  adapterMs: round(adapterMs),
  overheadPercent: round(((adapterMs - directMs) / Math.max(directMs, 0.01)) * 100),
}
if (Bun.argv.includes("--json")) console.log(JSON.stringify(result))
else
  console.log(
    `Pi direct: ${result.directMs}ms · adapter: ${result.adapterMs}ms · overhead: ${result.overheadPercent}%`,
  )

async function nextLine(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  getBuffer: () => string,
  setBuffer: (value: string) => void,
): Promise<string> {
  for (;;) {
    const buffer = getBuffer()
    const newline = buffer.indexOf("\n")
    if (newline >= 0) {
      setBuffer(buffer.slice(newline + 1))
      return buffer.slice(0, newline)
    }
    const { done, value } = await reader.read()
    if (done) throw new Error("Pi benchmark process exited before an event")
    setBuffer(buffer + decoder.decode(value, { stream: true }))
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
