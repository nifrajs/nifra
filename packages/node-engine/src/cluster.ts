/**
 * EXPERIMENTAL - not for release. One nifra app on every core: a primary process supervises worker
 * processes that each run the engine on the same port with `SO_REUSEPORT`, so the kernel spreads
 * accepted connections across them.
 *
 *   import { serveCluster } from "@nifrajs/node-engine/cluster"
 *   const node = await serveCluster(() => buildApp(), { port: 3000 })
 *
 * The file runs in the primary and again in every worker, as with `node:cluster`; `node.role` says
 * which one this is. The app is built only in workers, so the primary stays small and never loads
 * the engine. Workers share nothing: keep state in the app's own stores.
 *
 * Needs `SO_REUSEPORT` (Linux, macOS, BSD). The Linux kernel balances accepts across the workers;
 * macOS and BSD accept the shared bind but do not balance it.
 */
import cluster, { type Worker } from "node:cluster"
import { randomBytes } from "node:crypto"
import { availableParallelism } from "node:os"
import type { EngineServer, FetchHandler, NodeStopOptions, ServeOptions } from "./options.ts"
import { serve } from "./serve.ts"

export interface ClusterOptions extends ServeOptions {
  /** Fixed port every worker binds with `SO_REUSEPORT`. */
  readonly port: number
  /** Worker processes. Default: one per available core. */
  readonly workers?: number
  /** Start a replacement when a worker dies while the cluster is running. Default `true`. */
  readonly respawn?: boolean
  /** Told of every worker coming up and every worker going away; runs in the primary. */
  readonly onWorkerEvent?: (event: ClusterWorkerEvent) => void
}

export type ClusterWorkerEvent =
  | { readonly type: "listening"; readonly id: number; readonly pid: number }
  | {
      readonly type: "exit"
      readonly id: number
      readonly pid: number
      readonly code: number | null
      readonly signal: string | null
      /** A replacement follows. */
      readonly respawning: boolean
    }

export interface ClusterRestartOptions extends NodeStopOptions {
  /** How long a new worker has to start listening before the restart gives up. Default 30 s. */
  readonly startTimeoutMs?: number
}

export interface ClusterWorkerInfo {
  readonly id: number
  readonly pid: number
}

export interface ClusterPrimary {
  readonly role: "primary"
  readonly port: number
  /** The workers listening now. */
  workers(): readonly ClusterWorkerInfo[]
  /**
   * Stop every worker as `serve().stop()` stops one server - `onStopping` hooks, `delayMs`, a drain
   * of up to `drainMs` - then resolve once they have all exited. A worker still alive well past that
   * is killed.
   */
  stop(options?: NodeStopOptions): Promise<void>
  /**
   * Replace every worker, one at a time: a new worker starts and is listening before the one it
   * replaces is stopped (with `drainMs` and `delayMs`, as `stop()`), so the port is always served and
   * capacity never drops. The new workers run whatever the entry file and its imports are on disk
   * now. Resolves when the last old worker has exited. Rejects, leaving the workers not yet replaced
   * running, when a new worker does not start within `startTimeoutMs` or the cluster stops meanwhile.
   * A call while one is under way returns that one.
   *
   * `SO_REUSEPORT` drops the connections waiting in a closing worker's accept queue, so a client may
   * see a reset on a connection it opened in that instant; clients that retry an idempotent request
   * never notice.
   */
  restart(options?: ClusterRestartOptions): Promise<void>
  /**
   * `reloadTls()` in every worker, resolving when each has answered. Rejects naming the workers that
   * refused; the others have changed. The certificate must be given as PEM text or file names, since
   * it crosses a process boundary.
   */
  reloadTls(tls?: NonNullable<ServeOptions["tls"]>): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export interface ClusterWorker {
  readonly role: "worker"
  readonly server: EngineServer
}

const TICKET_ENV = "NIFRA_ENGINE_TICKET_KEYS"
const QUICK_EXIT_MS = 5000
const MAX_QUICK_EXITS = 10
const KILL_GRACE_MS = 5000
const ACK_TIMEOUT_MS = 10_000
const DEFAULT_START_TIMEOUT_MS = 30_000
const DEFAULT_DRAIN_MS = 10_000

type ToWorker =
  | { readonly nifra: "init"; readonly tls?: ServeOptions["tls"] }
  | { readonly nifra: "stop"; readonly options: NodeStopOptions }
  | { readonly nifra: "reloadTls"; readonly id: number; readonly tls?: ServeOptions["tls"] }

type ToPrimary =
  | { readonly nifra: "hello" }
  | { readonly nifra: "listening"; readonly port: number }
  | { readonly nifra: "error"; readonly message: string }
  | { readonly nifra: "reloaded"; readonly id: number; readonly error?: string }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isNonIpcTlsValue = (value: unknown): boolean =>
  value instanceof ArrayBuffer ||
  ArrayBuffer.isView(value) ||
  (Array.isArray(value) ? value.some(isNonIpcTlsValue) : isObject(value))

function snapshotIpcTls(tls: NonNullable<ServeOptions["tls"]>): NonNullable<ServeOptions["tls"]> {
  if (Object.values(tls).some((value) => isNonIpcTlsValue(value))) {
    throw new TypeError(
      "@nifrajs/node-engine: give the certificate as PEM text or file names; it crosses a process boundary",
    )
  }
  const ca = Array.isArray(tls.ca) ? tls.ca.map((item) => String(item)) : tls.ca
  const crl = Array.isArray(tls.crl) ? tls.crl.map((item) => String(item)) : tls.crl
  return {
    ...tls,
    ...(ca === undefined ? {} : { ca }),
    ...(crl === undefined ? {} : { crl }),
  }
}

function isToWorker(message: unknown): message is ToWorker {
  return (
    isObject(message) &&
    (message.nifra === "init" || message.nifra === "stop" || message.nifra === "reloadTls")
  )
}

function isToPrimary(message: unknown): message is ToPrimary {
  return (
    isObject(message) &&
    (message.nifra === "hello" ||
      message.nifra === "listening" ||
      message.nifra === "error" ||
      message.nifra === "reloaded")
  )
}

/** Ask the primary what to start with, so a worker never listens with a certificate since replaced. */
function askForTls(): Promise<ServeOptions["tls"]> {
  return new Promise((resolve) => {
    const onMessage = (message: unknown): void => {
      if (!isToWorker(message)) return
      if (message.nifra === "stop") process.exit(0)
      if (message.nifra !== "init") return
      process.removeListener("message", onMessage)
      resolve(message.tls)
    }
    process.on("message", onMessage)
    const hello: ToPrimary = { nifra: "hello" }
    process.send?.(hello)
  })
}

/** Whether a starting worker came up, never will, or is still not listening after `timeoutMs`. */
function startOutcome(ready: Promise<void>, timeoutMs: number): Promise<"up" | "gone" | "late"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("late"), timeoutMs)
    const settle = (outcome: "up" | "gone"): void => {
      clearTimeout(timer)
      resolve(outcome)
    }
    ready.then(
      () => settle("up"),
      () => settle("gone"),
    )
  })
}

/**
 * Run `app` on every core. The primary returns once every worker is listening; a worker returns once
 * its server is. Rejects in the primary when a worker cannot start, after stopping the others.
 */
export function serveCluster(
  app: () => FetchHandler | Promise<FetchHandler>,
  options: ClusterOptions,
): Promise<ClusterPrimary | ClusterWorker> {
  if (typeof options.port !== "number" || !Number.isInteger(options.port) || options.port < 1) {
    return Promise.reject(
      new TypeError(
        "@nifrajs/node-engine: a cluster needs a fixed `port` (workers cannot share an ephemeral one)",
      ),
    )
  }
  const workers = options.workers ?? availableParallelism()
  if (!Number.isInteger(workers) || workers < 1) {
    return Promise.reject(
      new TypeError("@nifrajs/node-engine: `workers` must be a positive integer"),
    )
  }
  if (process.platform === "win32") {
    return Promise.reject(
      new Error(
        "@nifrajs/node-engine: clustering needs SO_REUSEPORT, which Windows does not offer",
      ),
    )
  }
  return cluster.isPrimary ? runPrimary(options, workers) : runWorker(app, options)
}

async function runWorker(
  app: () => FetchHandler | Promise<FetchHandler>,
  options: ClusterOptions,
): Promise<ClusterWorker> {
  const { workers: _workers, respawn: _respawn, onWorkerEvent: _onWorkerEvent, ...rest } = options
  const hex = process.env[TICKET_ENV]
  // The ticket key decrypts resumed sessions: a process the app spawns must not inherit it.
  delete process.env[TICKET_ENV]
  const autoTicketKeys =
    options.tls?.ticketKeys === undefined && hex !== undefined ? Buffer.from(hex, "hex") : undefined
  // Keys preserved on a certificate-only reload: explicit keys first, then primary-generated keys.
  const fallbackTicketKeys = options.tls?.ticketKeys ?? autoTicketKeys
  const reloaded = await askForTls()
  const current =
    reloaded === undefined
      ? options.tls
      : options.tls?.ticketKeys === undefined
        ? reloaded
        : { ticketKeys: options.tls.ticketKeys, ...reloaded }
  const tls =
    current === undefined || current.ticketKeys !== undefined || fallbackTicketKeys === undefined
      ? current
      : { ...current, ticketKeys: fallbackTicketKeys }
  let server: EngineServer
  try {
    server = await serve(await app(), {
      ...rest,
      ...(tls === undefined ? {} : { tls }),
      engine: { ...options.engine, reusePort: true },
    })
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    const reported: ToPrimary = { nifra: "error", message }
    // Exit once the report is flushed: the IPC channel would otherwise keep the process alive.
    const send = process.send?.bind(process)
    if (send === undefined) process.exit(1)
    send(reported, undefined, undefined, () => process.exit(1))
    throw error
  }

  let stopping: Promise<void> | undefined
  const shutdown = (stopOptions: NodeStopOptions): Promise<void> => {
    stopping ??= server.stop(stopOptions).then(
      () => process.exit(0),
      () => process.exit(1),
    )
    return stopping
  }
  process.on("message", (message: unknown) => {
    if (!isToWorker(message)) return
    if (message.nifra === "stop") {
      void shutdown(message.options)
      return
    }
    if (message.nifra !== "reloadTls") return
    let error: string | undefined
    try {
      const nextTls =
        message.tls === undefined
          ? undefined
          : message.tls.ticketKeys === undefined && fallbackTicketKeys !== undefined
            ? { ...message.tls, ticketKeys: fallbackTicketKeys }
            : message.tls
      server.reloadTls(nextTls)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
    const reply: ToPrimary =
      error === undefined
        ? { nifra: "reloaded", id: message.id }
        : { nifra: "reloaded", id: message.id, error }
    process.send?.(reply)
  })
  // A terminal's Ctrl-C reaches the whole group, and a primary that has gone leaves no one to ask.
  process.on("SIGINT", () => void shutdown({}))
  process.on("SIGTERM", () => void shutdown({}))
  process.on("disconnect", () => void shutdown({}))
  const listening: ToPrimary = { nifra: "listening", port: server.port }
  process.send?.(listening)
  return { role: "worker", server }
}

interface Slot {
  readonly worker: Worker
  readonly startedAt: number
  listening: boolean
  /** Has been given its certificate, so only a reload can change it. */
  started: boolean
  /** Being replaced on purpose: its exit is expected and starts nothing. */
  retiring: boolean
  /** Settles when the worker is listening, or rejects when it cannot get there. */
  readonly ready: Promise<void>
}

async function runPrimary(options: ClusterOptions, count: number): Promise<ClusterPrimary> {
  const env: Record<string, string> =
    options.tls === undefined || options.tls.ticketKeys !== undefined
      ? {}
      : { [TICKET_ENV]: randomBytes(48).toString("hex") }
  const slots = new Map<number, Slot>()
  const respawn = options.respawn ?? true
  let stopping = false
  let quickExits = 0
  let nextAck = 1
  const acks = new Map<number, (worker: number, error: string | undefined) => void>()
  const timers = new Set<NodeJS.Timeout>()
  /** The certificate last given to `reloadTls`, which a replacement worker must start serving. */
  let currentTls: NonNullable<ServeOptions["tls"]> | undefined
  /** Settles when no reload is under way; a worker starting meanwhile waits for its outcome. */
  let reloading: Promise<unknown> = Promise.resolve()

  const emit = (event: ClusterWorkerEvent): void => {
    try {
      options.onWorkerEvent?.(event)
    } catch {
      // A reporting hook that throws must not take the supervisor down.
    }
  }

  const spawn = (replacement = false): Slot => {
    const worker = cluster.fork(env)
    let resolve!: () => void
    let reject!: (error: Error) => void
    const ready = new Promise<void>((done, fail) => {
      resolve = done
      reject = fail
    })
    // A caller that never asks (a respawn) must not leave this unhandled.
    ready.catch(() => {})
    const slot: Slot = {
      worker,
      startedAt: Date.now(),
      listening: false,
      started: false,
      retiring: false,
      ready,
    }
    slots.set(worker.id, slot)
    let failure: string | undefined
    worker.on("message", (message: unknown) => {
      if (!isToPrimary(message)) return
      if (message.nifra === "hello") {
        const init = (): void => {
          if (!worker.isConnected()) return
          slot.started = true
          const reply: ToWorker =
            currentTls === undefined ? { nifra: "init" } : { nifra: "init", tls: currentTls }
          // A send that fails means the worker has gone; its `exit` handles that.
          worker.send(reply, () => {})
        }
        void reloading.then(init, init)
      } else if (message.nifra === "listening") {
        slot.listening = true
        emit({ type: "listening", id: worker.id, pid: worker.process.pid ?? 0 })
        resolve()
      } else if (message.nifra === "error") {
        failure = message.message
      } else {
        acks.get(message.id)?.(worker.id, message.error)
      }
    })
    worker.once("exit", (code, signal) => {
      slots.delete(worker.id)
      const uptime = Date.now() - slot.startedAt
      const unexpected = !stopping && !slot.retiring
      quickExits = uptime < QUICK_EXIT_MS && unexpected ? quickExits + 1 : 0
      // A replacement that dies before it listens is tried again: only the first start fails the cluster.
      const again =
        unexpected && respawn && (slot.listening || replacement) && quickExits <= MAX_QUICK_EXITS
      emit({
        type: "exit",
        id: worker.id,
        pid: worker.process.pid ?? 0,
        code,
        signal,
        respawning: again,
      })
      if (!slot.listening) {
        reject(new Error(failure ?? `a worker exited before it was listening (code ${code})`))
      }
      if (!again) return
      const delay = quickExits === 0 ? 0 : Math.min(5000, 100 * 2 ** (quickExits - 1))
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (!stopping) spawn(true)
      }, delay)
      timers.add(timer)
    })
    return slot
  }

  const exited = (worker: Worker): Promise<void> =>
    new Promise<void>((resolve) => {
      if (worker.isDead()) resolve()
      else worker.once("exit", () => resolve())
    })

  let shutdown: Promise<void> | undefined
  const stopAll = (stopOptions: NodeStopOptions = {}): Promise<void> => {
    shutdown ??= (async () => {
      stopping = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      process.removeListener("SIGTERM", onSignal)
      process.removeListener("SIGINT", onSignal)
      const budget =
        (stopOptions.drainMs ?? DEFAULT_DRAIN_MS) + (stopOptions.delayMs ?? 0) + KILL_GRACE_MS
      const all = [...slots.values()].map((slot) => slot.worker)
      const killer = setTimeout(() => {
        for (const worker of all) if (!worker.isDead()) worker.process.kill("SIGKILL")
      }, budget)
      for (const worker of all) {
        const message: ToWorker = { nifra: "stop", options: stopOptions }
        if (worker.isConnected()) {
          worker.send(message, (error) => {
            if (error !== null) worker.process.kill("SIGTERM")
          })
        } else worker.process.kill("SIGTERM")
      }
      await Promise.all(all.map(exited))
      clearTimeout(killer)
    })()
    return shutdown
  }

  let restarting: Promise<void> | undefined
  const restart = (restartOptions: ClusterRestartOptions = {}): Promise<void> => {
    if (stopping)
      return Promise.reject(new Error("@nifrajs/node-engine: the cluster is not running"))
    restarting ??= rolling(restartOptions).finally(() => {
      restarting = undefined
    })
    return restarting
  }
  async function rolling(restartOptions: ClusterRestartOptions): Promise<void> {
    const { startTimeoutMs = DEFAULT_START_TIMEOUT_MS, ...stopOptions } = restartOptions
    const budget =
      (stopOptions.drainMs ?? DEFAULT_DRAIN_MS) + (stopOptions.delayMs ?? 0) + KILL_GRACE_MS
    // Workers that die meanwhile are replaced by the ordinary respawn; only these are retired.
    const retiring = [...slots.values()].filter((slot) => slot.listening)
    for (const old of retiring) {
      if (stopping)
        throw new Error(
          "@nifrajs/node-engine: the cluster is not running, so the restart cannot continue",
        )
      if (old.worker.isDead()) continue
      const fresh = spawn()
      const timer = setTimeout(() => fresh.worker.process.kill("SIGKILL"), startTimeoutMs)
      try {
        await fresh.ready
      } catch (error) {
        // The workers not yet retired are still serving; the restart stops here.
        throw new Error(
          `@nifrajs/node-engine: a new worker is not listening, so the restart stopped: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        )
      } finally {
        clearTimeout(timer)
      }
      old.retiring = true
      const gone = exited(old.worker)
      const killer = setTimeout(() => old.worker.process.kill("SIGKILL"), budget)
      const message: ToWorker = { nifra: "stop", options: stopOptions }
      if (old.worker.isConnected()) {
        old.worker.send(message, (error) => {
          if (error !== null) old.worker.process.kill("SIGTERM")
        })
      } else old.worker.process.kill("SIGTERM")
      await gone
      clearTimeout(killer)
    }
  }

  const signals = options.gracefulSignals === true ? {} : options.gracefulSignals || undefined
  const onSignal = (): void => {
    void stopAll(signals)
  }

  try {
    // The first worker that cannot start ends the wait: a sibling still starting would otherwise keep it open.
    await Promise.all(Array.from({ length: count }, () => spawn().ready))
  } catch (error) {
    await stopAll({ drainMs: 0 })
    throw error
  }
  if (signals !== undefined) {
    process.once("SIGTERM", onSignal)
    process.once("SIGINT", onSignal)
  }

  const applyTls = async (snapshot?: NonNullable<ServeOptions["tls"]>): Promise<void> => {
    if (stopping) throw new Error("@nifrajs/node-engine: the cluster is not running")
    if (options.tls === undefined) {
      throw new Error("@nifrajs/node-engine: reloadTls requires a cluster started with `tls`")
    }
    // Every worker that holds a certificate, the ones still starting included.
    const targets = [...slots.values()].filter((slot) => slot.started)
    const failures: string[] = []
    await Promise.all(
      targets.map(async (slot) => {
        const outcome = await startOutcome(slot.ready, DEFAULT_START_TIMEOUT_MS)
        if (outcome === "gone") return // It never listened, so it serves nothing.
        if (outcome === "late") {
          failures.push(`worker ${slot.worker.id}: still starting`)
          return
        }
        await new Promise<void>((resolve) => {
          const id = nextAck++
          const done = (worker: number, error: string | undefined): void => {
            clearTimeout(timer)
            acks.delete(id)
            if (error !== undefined) failures.push(`worker ${worker}: ${error}`)
            resolve()
          }
          const timer = setTimeout(() => done(slot.worker.id, "no answer"), ACK_TIMEOUT_MS)
          acks.set(id, done)
          const message: ToWorker =
            snapshot === undefined
              ? { nifra: "reloadTls", id }
              : { nifra: "reloadTls", id, tls: snapshot }
          // A send to a worker that has gone fails through the callback; without one it would be
          // an `error` event nobody listens to, which ends the primary.
          slot.worker.send(message, (error) => {
            if (error !== null) done(slot.worker.id, "could not be reached")
          })
        })
      }),
    )
    if (failures.length > 0) {
      throw new Error(`@nifrajs/node-engine: reloadTls is not applied by ${failures.join("; ")}`)
    }
    if (snapshot !== undefined) currentTls = snapshot
  }

  // One at a time, in call order: a worker that starts during one waits to be told its result.
  const reloadTls = (tls?: NonNullable<ServeOptions["tls"]>): Promise<void> => {
    let snapshot: NonNullable<ServeOptions["tls"]> | undefined
    try {
      snapshot = tls === undefined ? undefined : snapshotIpcTls(tls)
    } catch (error) {
      return Promise.reject(error)
    }
    const next = reloading.then(
      () => applyTls(snapshot),
      () => applyTls(snapshot),
    )
    reloading = next
    return next
  }

  return {
    role: "primary",
    port: options.port,
    workers: () =>
      [...slots.values()]
        .filter((slot) => slot.listening)
        .map((slot) => ({ id: slot.worker.id, pid: slot.worker.process.pid ?? 0 })),
    stop: stopAll,
    restart,
    reloadTls,
    [Symbol.asyncDispose]: () => shutdown ?? stopAll(),
  }
}
