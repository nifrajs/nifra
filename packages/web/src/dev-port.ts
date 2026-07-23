/**
 * `@nifrajs/web/dev-port` — what a dev server says when it cannot bind.
 *
 * Both pipelines need this and neither should own it: the Vite server binds through Node's `http`
 * (asynchronous `error` event), the Bun server binds through `Bun.serve` (synchronous throw). Two very
 * different failure mechanics, one thing the developer has to be told.
 *
 * That message is worth this much care because the visible symptom is not the real one. When the port is
 * taken, the EARLIER dev server is still answering on it, still serving the build it started with. Every
 * subsequent edit appears to do nothing. What reaches the developer is "my changes stopped reaching SSR",
 * which reads as broken HMR or a stale module graph and sends them into the module graph - not to the one
 * process that never started. Naming the cause here is the entire fix.
 *
 * This module deliberately imports nothing: it is shared by a Node-http path and a Bun path, and the
 * structural `ListenTarget` keeps it free of either runtime's types.
 */

/** The `EADDRINUSE` explanation. Exported so tests pin the exact text a user will read. */
export function portInUseMessage(port: number): string {
  return (
    `[nifra] dev server can't start: port ${port} is already in use.\n` +
    `  Most likely an earlier \`nifra dev\` is still running. It keeps serving the PREVIOUS build, so ` +
    `every edit will look like it stops reaching SSR while the browser shows stale output.\n` +
    `  Free the port:  lsof -ti:${port} | xargs kill\n` +
    `  Or use another: nifra dev --port ${port + 1}`
  )
}

/** True when an unknown thrown value carries the "address already in use" errno. */
export const isAddressInUse = (err: unknown): boolean =>
  (err as { code?: unknown } | null)?.code === "EADDRINUSE"

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

/** Map a bind failure to the port-collision explanation, leaving every other failure as itself. */
export const explainBindFailure = (err: unknown, port: number): Error =>
  isAddressInUse(err) ? new Error(portInUseMessage(port)) : asError(err)

/** The bits of a Node server {@link listenOrExplain} touches — structural, so a test can fake it. */
export interface ListenTarget {
  listen(port: number, cb: () => void): void
  once(event: "error", cb: (err: unknown) => void): void
  removeListener(event: "error", cb: (err: unknown) => void): void
}

/**
 * `listen`, but a bind failure becomes a readable nifra error instead of Node's raw internal throw.
 *
 * Without an `error` listener attached, Node throws from deep inside `node:events`, the new process dies
 * in the background, and nothing connects that death to the stale page in front of you.
 */
export function listenOrExplain(server: ListenTarget, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: unknown): void => reject(explainBindFailure(err, port))
    server.once("error", onError)
    server.listen(port, () => {
      // Drop the guard once we're listening: leaving it attached would funnel a LATER server error into
      // an already-settled promise, silently swallowing it instead of surfacing it.
      server.removeListener("error", onError)
      resolve()
    })
  })
}
