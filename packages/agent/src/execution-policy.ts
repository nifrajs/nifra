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
      const value = values[name] ?? process.env[name]
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
      })
    } catch {
      reject(new LocalProcessPolicyError("invalid_request"))
      return
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
      child.kill()
      reject(new LocalProcessPolicyError("invalid_request"))
      return
    }
    child.stdout.on("data", (chunk: Uint8Array) => append(stdout, chunk))
    child.stderr.on("data", (chunk: Uint8Array) => append(stderr, chunk))
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const terminate = (): void => {
      child.kill("SIGTERM")
      // A child that ignores SIGTERM would otherwise leave this promise pending forever,
      // making policy.timeMs advisory instead of a bound.
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS)
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, input.policy.timeMs)
    const cancel = (): void => {
      cancelled = true
      terminate()
    }
    input.signal?.addEventListener("abort", cancel, { once: true })
    child.once("error", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      reject(new LocalProcessPolicyError("invalid_request"))
    })
    child.once("close", (exitCode, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
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
    })
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
