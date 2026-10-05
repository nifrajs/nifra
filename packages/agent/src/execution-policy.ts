import { spawn } from "node:child_process"
import { isAbsolute, relative, resolve, sep } from "node:path"
import {
  defineExecutionPolicy,
  type ExecutionPolicy,
  type ExecutionPolicyAdapter,
} from "@nifrajs/core/execution-policy"

/** This statement is intentionally repeated in the API and runtime result. */
export const LOCAL_PROCESS_LIMITATION = "The local adapter is NOT a security boundary."

const SIGKILL_GRACE_MS = 2000
/** How long the pipes may stay open after the escalation kill before the run stops reading them. */
const PIPE_RELEASE_MS = 200
/** The longest delay setTimeout honors; past it the callback fires at once. */
const MAX_TIMER_MS = 2_147_483_647
// On POSIX each run leads its own process group, so a timeout, a cancel, the run's own end, or the
// host's exit ends every process the command started, not only the direct child.
const WINDOWS = process.platform === "win32"
const PROCESS_GROUPS = !WINDOWS
const liveGroups = new Set<number>()
let exitHookInstalled = false

export interface LocalProcessAdapterOptions {
  readonly cwd?: string
  /** Only these inherited environment names are copied. Default: PATH, LANG, and LC_ALL. */
  readonly envAllowlist?: readonly string[]
  readonly maxOutputBytes?: number
}

export interface LocalProcessRequest {
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly capability?: string
  readonly policy: ExecutionPolicy
  readonly signal?: AbortSignal
}

export interface LocalProcessResult {
  readonly ok: boolean
  readonly exitCode: number | null
  readonly signal?: string
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly cancelled: boolean
  readonly limitations: readonly string[]
}

export class LocalProcessPolicyError extends Error {
  constructor(readonly code: "policy_unsatisfied" | "invalid_request" | "cancelled") {
    super(`local process: ${code}. ${LOCAL_PROCESS_LIMITATION}`)
    this.name = "LocalProcessPolicyError"
  }
}

export interface LocalProcessAdapter extends ExecutionPolicyAdapter {
  run(request: LocalProcessRequest): Promise<LocalProcessResult>
}

/**
 * Run a command with the host controls available to a normal child process. The local adapter is NOT
 * a security boundary. Without OS-level sandboxing it contains crashes and accidents, not hostile code.
 */
export function createLocalProcessAdapter(
  options: LocalProcessAdapterOptions = {},
): LocalProcessAdapter {
  const cwd = options.cwd ?? process.cwd()
  const allowlist = new Set(options.envAllowlist ?? ["PATH", "LANG", "LC_ALL"])
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new RangeError("local process: maxOutputBytes must be a positive safe integer")
  }
  const adapter: LocalProcessAdapter = {
    name: "local-process",
    canSatisfy(policyInput) {
      const policy = defineExecutionPolicy(policyInput)
      return (
        policy.filesystem === "cwd" &&
        policy.network === "allow" &&
        policy.capabilityCeiling.length > 0
      )
    },
    limitations(policyInput) {
      const policy = defineExecutionPolicy(policyInput)
      const limitations = [LOCAL_PROCESS_LIMITATION]
      if (policy.filesystem !== "cwd") limitations.push("filesystem-scope-not-enforced")
      if (policy.network === "deny") limitations.push("network-denial-not-enforced")
      limitations.push("capability-ceiling-is-admission-only")
      return Object.freeze(limitations)
    },
    async run(request) {
      const policy = defineExecutionPolicy(request.policy)
      if (
        typeof request.command !== "string" ||
        request.command.trim() === "" ||
        request.args?.some((arg) => typeof arg !== "string")
      ) {
        throw new LocalProcessPolicyError("invalid_request")
      }
      if (!(await adapter.canSatisfy(policy)))
        throw new LocalProcessPolicyError("policy_unsatisfied")
      if (
        request.capability !== undefined &&
        !policy.capabilityCeiling.includes(request.capability)
      ) {
        throw new LocalProcessPolicyError("policy_unsatisfied")
      }
      if (request.signal?.aborted === true) throw new LocalProcessPolicyError("cancelled")
      const processCwd = resolve(cwd, request.cwd ?? ".")
      if (policy.filesystem === "cwd" && !isWithin(processCwd, cwd))
        throw new LocalProcessPolicyError("policy_unsatisfied")
      const env = filteredEnv(request.env ?? {})
      return spawnProcess({
        command: request.command,
        args: request.args ?? [],
        cwd: processCwd,
        env,
        policy,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        maxOutputBytes,
        limitations: adapter.limitations(policy),
      })
    },
  }
  return Object.freeze(adapter)

  function filteredEnv(
    values: Readonly<Record<string, string | undefined>>,
  ): Record<string, string> {
    const result: Record<string, string> = {}
    for (const name of allowlist) {
      const value = Object.hasOwn(values, name) ? values[name] : process.env[name]
      if (value !== undefined) result[name] = value
    }
    return result
  }
}

function isWithin(path: string, root: string): boolean {
  const resolvedPath = resolve(path)
  const resolvedRoot = resolve(root)
  const distance = relative(resolvedRoot, resolvedPath)
  return (
    distance === "" ||
    (distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance))
  )
}

interface SpawnInput {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly policy: ExecutionPolicy
  readonly signal?: AbortSignal
  readonly maxOutputBytes: number
  readonly limitations: readonly string[]
}

function spawnProcess(input: SpawnInput): Promise<LocalProcessResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: PROCESS_GROUPS,
      })
    } catch {
      reject(new LocalProcessPolicyError("invalid_request"))
      return
    }
    const group = PROCESS_GROUPS ? child.pid : undefined
    if (group !== undefined) trackGroup(group)
    const signalAll = (signal: NodeJS.Signals): void => {
      if (group !== undefined && signalGroup(group, signal)) return
      if (WINDOWS && child.pid !== undefined && child.exitCode === null) windowsTreeKill(child.pid)
      else child.kill(signal)
    }
    const stdout: Uint8Array[] = []
    const stderr: Uint8Array[] = []
    let timedOut = false
    let cancelled = false
    let settled = false
    const outputUsed = { value: 0 }
    const append = (target: Uint8Array[], chunk: Uint8Array): void => {
      const remaining = input.maxOutputBytes - outputUsed.value
      if (remaining <= 0) return
      const selected = chunk.byteLength <= remaining ? chunk : chunk.slice(0, remaining)
      target.push(selected)
      outputUsed.value += selected.byteLength
    }
    if (child.stdout === null || child.stderr === null) {
      signalAll("SIGKILL")
      if (group !== undefined) liveGroups.delete(group)
      reject(new LocalProcessPolicyError("invalid_request"))
      return
    }
    child.stdout.on("data", (chunk: Uint8Array) => append(stdout, chunk))
    child.stderr.on("data", (chunk: Uint8Array) => append(stderr, chunk))
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let releaseTimer: ReturnType<typeof setTimeout> | undefined
    const terminate = (): void => {
      signalAll("SIGTERM")
      // A process that ignores SIGTERM would otherwise leave this promise pending forever,
      // making policy.timeMs advisory instead of a bound.
      killTimer ??= setTimeout(() => {
        signalAll("SIGKILL")
        // A process that left the group (setsid) can still hold the pipes open; stop waiting.
        releaseTimer = setTimeout(() => settle(child.exitCode, child.signalCode), PIPE_RELEASE_MS)
      }, SIGKILL_GRACE_MS)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = performance.now() + input.policy.timeMs
    const arm = (): void => {
      const remaining = deadline - performance.now()
      timer =
        remaining > MAX_TIMER_MS
          ? setTimeout(arm, MAX_TIMER_MS)
          : setTimeout(() => {
              timedOut = true
              terminate()
            }, remaining)
    }
    arm()
    const cancel = (): void => {
      cancelled = true
      terminate()
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      if (releaseTimer !== undefined) clearTimeout(releaseTimer)
      if (group !== undefined) liveGroups.delete(group)
      input.signal?.removeEventListener("abort", cancel)
    }
    child.once("error", () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new LocalProcessPolicyError("invalid_request"))
    })
    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      // A background process the command left behind ends with the run.
      if (group !== undefined) signalGroup(group, "SIGKILL")
      cleanup()
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({
        ok: !timedOut && !cancelled && exitCode === 0,
        exitCode,
        ...(signal === null ? {} : { signal }),
        stdout: new TextDecoder().decode(concat(stdout)),
        stderr: new TextDecoder().decode(concat(stderr)),
        timedOut,
        cancelled,
        limitations: input.limitations,
      })
    }
    child.once("close", settle)
    input.signal?.addEventListener("abort", cancel, { once: true })
    if (input.signal?.aborted === true) cancel() // close the precheck/listener-registration race
  })
}

/**
 * End a Windows process and its descendants. Windows has no process groups, and a console child
 * cannot be asked to stop, so the tree is terminated outright.
 */
export function windowsTreeKill(
  pid: number,
  run: (
    command: string,
    args: readonly string[],
    options: { stdio: "ignore"; windowsHide: boolean },
  ) => { on(event: "error", listener: () => void): unknown } = spawn,
): void {
  try {
    run("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on(
      "error",
      () => {},
    )
  } catch {}
}

/** Signal a run's whole process group; false when the group is already gone. */
function signalGroup(group: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-group, signal)
    return true
  } catch {
    return false
  }
}

function trackGroup(group: number): void {
  liveGroups.add(group)
  if (exitHookInstalled) return
  exitHookInstalled = true
  // A detached group outlives the host unless something ends it; runs still in flight end with it.
  process.on("exit", () => {
    for (const live of liveGroups) signalGroup(live, "SIGKILL")
  })
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

export type { ExecutionPolicy, ExecutionPolicyAdapter }
export { defineExecutionPolicy }
