/** The React fixture app served by a Deno process: `PPR_RUNTIME=deno` in `app-browser.ts` loads it. */
import { rmSync, writeFileSync } from "node:fs"
import { type PprApp, preparePprApp } from "./server.ts"

/** The React app on Deno's own server: Bun builds it, then a Deno process serves that build. */
export async function startPprAppOnDeno(): Promise<PprApp> {
  const prepared = await preparePprApp()
  const preparedFile = `${prepared.outDir}.json`
  writeFileSync(preparedFile, JSON.stringify(prepared))
  const child = Bun.spawn(
    [
      "deno",
      "run",
      "--allow-net=127.0.0.1",
      "--allow-read",
      "--allow-env",
      "--allow-sys",
      // The workspace packages' `bun` condition points at their sources, as the Bun server loads them.
      "--conditions=bun",
      `--config=${import.meta.dir}/deno.json`,
      `${import.meta.dir}/deno-server.ts`,
      preparedFile,
    ],
    { stdout: "pipe", stderr: "inherit" },
  )
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let printed = ""
  while (!printed.includes("\n")) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`the Deno server exited before it printed its origin: ${printed}`)
    printed += decoder.decode(value, { stream: true })
  }
  reader.releaseLock()
  const origin = printed.slice(0, printed.indexOf("\n"))
  return {
    origin,
    shellFailures: prepared.shellFailures,
    warnings: [],
    readWarnings: async () => (await fetch(`${origin}/__warnings`)).json(),
    async stop() {
      child.kill()
      await child.exited
      rmSync(prepared.outDir, { recursive: true, force: true })
      rmSync(preparedFile, { force: true })
    },
  }
}
