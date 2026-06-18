/** Spawn the fixture server (`_serve.ts`) as a real child process and wait for its `ready <port>`
 * line. Shared by the ops benches so every measurement is against a real socket, not in-process. */

export interface SpawnedServer {
  readonly port: number
  readonly proc: ReturnType<typeof Bun.spawn>
  kill(): void
  /** Lines the child printed (the soak bench reads `rss <bytes>` samples out of this). */
  readonly lines: string[]
}

export async function spawnServer(env: Record<string, string>): Promise<SpawnedServer> {
  const proc = Bun.spawn(["bun", new URL("./_serve.ts", import.meta.url).pathname], {
    stdout: "pipe",
    stderr: "inherit",
    env: { ...Bun.env, PORT: "0", ...env },
  })
  const lines: string[] = []
  let resolveReady: ((port: number) => void) | undefined
  const ready = new Promise<number>((resolve) => {
    resolveReady = resolve
  })
  ;(async () => {
    const decoder = new TextDecoder()
    let buf = ""
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk)
      let nl = buf.indexOf("\n")
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line.length > 0) lines.push(line)
        const m = line.match(/^ready (\d+)$/)
        if (m) resolveReady?.(Number(m[1]))
        nl = buf.indexOf("\n")
      }
    }
  })()
  const port = await ready
  return { port, proc, lines, kill: () => proc.kill() }
}
