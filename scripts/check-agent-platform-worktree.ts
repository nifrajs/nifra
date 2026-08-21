import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { allowlistForTask } from "./check-agent-platform-plan.ts"

const ROOT = resolve(import.meta.dir, "..")
const BASELINE_NAME = "agent-platform-worktree-baseline.json"

interface BaselineFile {
  readonly path: string
  readonly digest: string | null
  /** True when the path was dirty before the task started; clean included targets are protected, not overlaps. */
  readonly dirty?: boolean
}

export interface AgentPlatformWorktreeBaseline {
  readonly version: 1
  readonly commit: string
  readonly files: readonly BaselineFile[]
}

export interface WorktreeAudit {
  readonly ok: boolean
  readonly changed: readonly string[]
  readonly failures: readonly string[]
}

function git(...args: string[]): string {
  const result = spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`)
  return result.stdout
}

function gitDirectory(): string {
  const value = git("rev-parse", "--git-dir").trim()
  return resolve(ROOT, value)
}

function baselinePath(): string {
  return resolve(gitDirectory(), "nifra-agent-platform", BASELINE_NAME)
}

function digest(path: string): string | null {
  if (!existsSync(resolve(ROOT, path))) return null
  return createHash("sha256")
    .update(readFileSync(resolve(ROOT, path)))
    .digest("hex")
}

function digestAt(root: string, path: string): string | null {
  const absolute = resolve(root, path)
  if (!existsSync(absolute)) return null
  return createHash("sha256").update(readFileSync(absolute)).digest("hex")
}

function statusPathsAt(root: string): readonly string[] {
  const result = spawnSync(
    "git",
    ["-C", root, "status", "--porcelain=v2", "--untracked-files=all", "-z"],
    {
      encoding: "utf8",
    },
  )
  if (result.status !== 0) throw new Error(result.stderr.trim() || "git status failed")
  const output = result.stdout
  const paths = new Set<string>()
  for (const record of output.split("\0")) {
    if (record.length === 0) continue
    const tab = record.indexOf("\t")
    if (tab >= 0) {
      for (const path of record.slice(tab + 1).split("\0")) if (path.length > 0) paths.add(path)
      continue
    }
    if (record.startsWith("? ") || record.startsWith("! ")) paths.add(record.slice(2))
  }
  return Object.freeze([...paths].sort())
}

function statusPaths(): readonly string[] {
  return statusPathsAt(ROOT)
}

function readBaseline(): AgentPlatformWorktreeBaseline {
  const path = baselinePath()
  if (!existsSync(path)) throw new Error(`missing worktree baseline: ${path}`)
  const value = JSON.parse(readFileSync(path, "utf8")) as AgentPlatformWorktreeBaseline
  if (value.version !== 1 || typeof value.commit !== "string" || !Array.isArray(value.files))
    throw new Error("invalid worktree baseline")
  return value
}

export function captureAgentPlatformBaseline(
  options: {
    readonly exclude?: readonly string[]
    /** Include clean task targets so later generation can detect a target changing concurrently. */
    readonly include?: readonly string[]
  } = {},
): AgentPlatformWorktreeBaseline {
  const excluded = options.exclude ?? []
  const dirtyPaths = new Set(statusPaths())
  const paths = new Set([
    ...dirtyPaths,
    ...(options.include === undefined ? [] : allowlistedFiles(ROOT, options.include)),
  ])
  const files = [...paths]
    .filter((path) => !excluded.some((entry) => path === entry || path.startsWith(`${entry}/`)))
    .map((path) => ({
      path,
      digest: digest(path),
      ...(dirtyPaths.has(path) ? { dirty: true } : {}),
    }))
  const baseline: AgentPlatformWorktreeBaseline = Object.freeze({
    version: 1,
    commit: git("rev-parse", "HEAD").trim(),
    files: Object.freeze(files),
  })
  const directory = resolve(gitDirectory(), "nifra-agent-platform")
  mkdirSync(directory, { recursive: true })
  writeFileSync(resolve(directory, BASELINE_NAME), `${JSON.stringify(baseline)}\n`, { mode: 0o600 })
  return baseline
}

export function matchesAgentPlatformAllowlist(path: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => {
    if (entry.endsWith("/**"))
      return path === entry.slice(0, -3) || path.startsWith(`${entry.slice(0, -3)}/`)
    if (entry.includes("*")) {
      const pattern = new RegExp(`^${entry.split("*").map(escapeRegExp).join(".*")}$`)
      return pattern.test(path)
    }
    return path === entry
  })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function allowlistedFiles(root: string, allowlist: readonly string[]): readonly string[] {
  const files = new Set<string>()
  for (const entry of allowlist) {
    if (entry.endsWith("/**")) {
      const directory = resolve(root, entry.slice(0, -3))
      if (!existsSync(directory)) continue
      for (const path of new Bun.Glob("**/*").scanSync({ cwd: directory, dot: true })) {
        const absolute = resolve(directory, path)
        if (lstatSync(absolute).isFile()) files.add(relative(root, absolute).split(sep).join("/"))
      }
      continue
    }
    if (entry.includes("*")) {
      const slash = entry.lastIndexOf("/")
      const directory = resolve(root, slash < 0 ? "." : entry.slice(0, slash))
      const pattern = slash < 0 ? entry : entry.slice(slash + 1)
      if (!existsSync(directory)) continue
      for (const path of new Bun.Glob(pattern).scanSync({ cwd: directory, dot: true })) {
        const absolute = resolve(directory, path)
        if (lstatSync(absolute).isFile()) files.add(relative(root, absolute).split(sep).join("/"))
      }
      continue
    }
    if (existsSync(resolve(root, entry)) && lstatSync(resolve(root, entry)).isFile())
      files.add(entry)
  }
  return Object.freeze([...files].sort())
}

function linkedWorktreePath(): string {
  return join(tmpdir(), `nifra-agent-platform-worktree-${process.pid}-${Date.now()}`)
}

function addLinkedWorktree(path: string, commit: string): void {
  const result = spawnSync("git", ["-C", ROOT, "worktree", "add", "--detach", path, commit], {
    encoding: "utf8",
  })
  if (result.status !== 0) throw new Error(result.stderr.trim() || "git worktree add failed")
  // Install the frozen lockfile in the temporary worktree so workspace packages resolve to THIS
  // checkout. Reusing absolute workspace symlinks from the shared tree creates duplicate module
  // identities (notably the web navigation bridge) and makes a release test exercise mixed commits.
  // Bun's offline cache keeps this local and deterministic; the worktree remains disposable.
  const install = spawnSync("bun", ["install", "--frozen-lockfile", "--offline"], {
    cwd: path,
    stdio: "inherit",
    env: process.env,
  })
  if (install.status !== 0) throw new Error("bun install failed in isolated worktree")
  for (const workspaceRoot of ["packages", "apps", "internal", "bench"]) {
    const sourceRoot = resolve(ROOT, workspaceRoot)
    if (!existsSync(sourceRoot)) continue
    const sourceWorkspaceModules = resolve(sourceRoot, "node_modules")
    const targetWorkspaceModules = resolve(path, workspaceRoot, "node_modules")
    if (existsSync(sourceWorkspaceModules) && !existsSync(targetWorkspaceModules)) {
      try {
        symlinkSync(sourceWorkspaceModules, targetWorkspaceModules, "junction")
      } catch {
        // A clean consumer/release environment may install workspace-root dependencies instead.
      }
    }
    for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const source = resolve(sourceRoot, entry.name, "node_modules")
      const target = resolve(path, workspaceRoot, entry.name, "node_modules")
      const sourceDist = resolve(sourceRoot, entry.name, "dist")
      const targetDist = resolve(path, workspaceRoot, entry.name, "dist")
      if (existsSync(sourceDist) && !existsSync(targetDist))
        cpSync(sourceDist, targetDist, { recursive: true, force: true })
      if (!existsSync(source) || existsSync(target)) continue
      try {
        symlinkSync(source, target, "junction")
      } catch {
        // A clean consumer/release environment may install dependencies in the linked tree instead.
      }
    }
  }
}

function removeLinkedWorktree(path: string): void {
  spawnSync("git", ["-C", ROOT, "worktree", "remove", "--force", path], {
    encoding: "utf8",
  })
  rmSync(path, { recursive: true, force: true })
}

function copySharedSnapshot(path: string): void {
  // The program is commonly worked on before its phase commits are created. Overlaying the
  // current shared files into the clean linked worktree lets generators see those source changes,
  // while the output audit below still permits writes only to the task allowlist.
  for (const changed of statusPaths()) {
    if (changed === ".git" || changed.startsWith(".git/")) continue
    const source = resolve(ROOT, changed)
    const target = resolve(path, changed)
    if (existsSync(source)) {
      const stat = lstatSync(source)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) cpSync(source, target, { recursive: true, force: true })
      else {
        mkdirSync(resolve(target, ".."), { recursive: true })
        cpSync(source, target, { force: true })
      }
    } else if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  }
}

function changedFiles(
  root: string,
  before: ReadonlyMap<string, string | null>,
  allowlist: readonly string[],
  initial: ReadonlySet<string>,
): readonly string[] {
  const candidates = new Set([...allowlistedFiles(root, allowlist)])
  for (const path of statusPathsAt(root)) {
    if (initial.has(path) && !matchesAgentPlatformAllowlist(path, allowlist)) continue
    const absolute = resolve(root, path)
    if (!existsSync(absolute) || lstatSync(absolute).isFile()) candidates.add(path)
  }
  return Object.freeze(
    [...candidates].filter((path) => digestAt(root, path) !== before.get(path)).sort(),
  )
}

function copyGeneratedOutputs(
  sourceRoot: string,
  paths: readonly string[],
  baseline: AgentPlatformWorktreeBaseline,
): void {
  const baselineMap = new Map(baseline.files.map((file) => [file.path, file.digest]))
  for (const path of paths) {
    if (digest(path) !== (baselineMap.get(path) ?? null))
      throw new Error(`overlap: shared target changed while generation was isolated: ${path}`)
  }
  for (const path of paths) {
    const source = resolve(sourceRoot, path)
    const target = resolve(ROOT, path)
    if (!existsSync(source)) {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true })
      continue
    }
    if (!lstatSync(source).isFile()) throw new Error(`generated target is not a file: ${path}`)
    mkdirSync(resolve(target, ".."), { recursive: true })
    cpSync(source, target, { force: true })
  }
}

function runIsolated(
  mode: "generate" | "release",
  taskId: string,
  command: string,
  baseline: AgentPlatformWorktreeBaseline,
): number {
  const allowlist = allowlistForTask(ROOT, taskId)
  if (allowlist.length === 0) throw new Error(`unknown task or empty allowlist: ${taskId}`)
  if (mode === "release") {
    const markers = (process.env.PRIVATE_MARKERS ?? "")
      .split(",")
      .map((marker) => marker.trim())
      .filter(Boolean)
    if (markers.length === 0) throw new Error("PRIVATE_MARKERS must be non-empty for release mode")
  }
  const path = linkedWorktreePath()
  addLinkedWorktree(path, baseline.commit)
  try {
    if (mode === "generate") {
      copySharedSnapshot(path)
      const before = new Map(
        allowlistedFiles(path, allowlist).map((file) => [file, digestAt(path, file)]),
      )
      const initial = new Set(statusPathsAt(path))
      const result = spawnSync(command, {
        cwd: path,
        shell: true,
        stdio: "inherit",
        env: process.env,
      })
      if ((result.status ?? 1) !== 0) return result.status ?? 1
      const outputs = changedFiles(path, before, allowlist, initial)
      const failures = outputs.filter((file) => !matchesAgentPlatformAllowlist(file, allowlist))
      if (failures.length > 0)
        throw new Error(`isolated generator wrote outside allowlist: ${failures.join(", ")}`)
      const patchPath = resolve(path, ".agent-platform-generated.patch.json")
      writeFileSync(
        patchPath,
        `${JSON.stringify({ version: 1, taskId, paths: outputs, digests: outputs.map((file) => digestAt(path, file)) })}\n`,
        { mode: 0o600 },
      )
      copyGeneratedOutputs(path, outputs, baseline)
      console.log(`✓ isolated generation: ${outputs.length} allowlisted outputs applied`)
      return 0
    }
    const result = spawnSync(command, {
      cwd: path,
      shell: true,
      stdio: "inherit",
      env: process.env,
    })
    return result.status ?? 1
  } finally {
    removeLinkedWorktree(path)
  }
}

export function auditAgentPlatformWorktree(
  taskId: string | undefined,
  baseline: AgentPlatformWorktreeBaseline = readBaseline(),
  current: readonly string[] = statusPaths(),
): WorktreeAudit {
  const failures: string[] = []
  const changed = current
  const allowlist = taskId === undefined ? [] : allowlistForTask(ROOT, taskId)
  if (taskId !== undefined && allowlist.length === 0)
    failures.push(`unknown task or empty allowlist: ${taskId}`)
  const baselineMap = new Map(baseline.files.map((file) => [file.path, file.digest]))
  const currentSet = new Set(current)
  for (const file of baseline.files) {
    // Older baselines did not carry the optional `dirty` bit. A path that is still reported dirty
    // and has the same digest is necessarily pre-existing dirt; infer that fact for compatibility,
    // while leaving a changed clean target owned by the current task.
    const wasDirty =
      file.dirty === true || (currentSet.has(file.path) && digest(file.path) === file.digest)
    if (digest(file.path) !== file.digest) {
      const taskOwnsCleanTarget =
        taskId !== undefined && !wasDirty && matchesAgentPlatformAllowlist(file.path, allowlist)
      if (!taskOwnsCleanTarget) failures.push(`baseline file changed: ${file.path}`)
    }
    if (taskId !== undefined && wasDirty && matchesAgentPlatformAllowlist(file.path, allowlist))
      failures.push(`allowlisted target was already dirty at baseline: ${file.path}`)
  }
  for (const path of changed) {
    if (baselineMap.has(path)) continue
    if (taskId !== undefined && !matchesAgentPlatformAllowlist(path, allowlist))
      failures.push(`out-of-allowlist mutation: ${path}`)
  }
  return { ok: failures.length === 0, changed, failures: Object.freeze(failures) }
}

function usage(): never {
  console.error(
    "usage: check-agent-platform-worktree baseline [--task Pn-Tn] | verify [--task Pn-Tn] | generate --task Pn-Tn -- command | release --task Pn-Tn -- command",
  )
  process.exit(2)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const mode = args.shift()
  if (mode === "baseline") {
    const taskIndex = args.indexOf("--task")
    const taskId = taskIndex >= 0 ? args[taskIndex + 1] : undefined
    if (taskIndex >= 0) args.splice(taskIndex, 2)
    const excludeIndex = args.indexOf("--exclude")
    const exclude: string[] = []
    for (
      let index = excludeIndex;
      index >= 0 && index + 1 < args.length;
      index = args.indexOf("--exclude", index + 1)
    )
      exclude.push(args[index + 1]!)
    const taskAllowlist = taskId === undefined ? undefined : allowlistForTask(ROOT, taskId)
    const baseline = captureAgentPlatformBaseline({ exclude, include: taskAllowlist })
    if (taskId !== undefined && taskAllowlist?.length === 0)
      throw new Error(`unknown task or empty allowlist: ${taskId}`)
    console.log(`✓ worktree baseline: ${baseline.commit}, ${baseline.files.length} dirty paths`)
    process.exit(0)
  }
  if (mode !== "check" && mode !== "verify" && mode !== "generate" && mode !== "release") usage()
  const taskIndex = args.indexOf("--task")
  const taskId = taskIndex >= 0 ? args[taskIndex + 1] : undefined
  if (taskIndex >= 0) args.splice(taskIndex, 2)
  const separator = args.indexOf("--")
  const command = separator >= 0 ? args.slice(separator + 1).join(" ") : undefined
  if (separator >= 0) args.splice(separator)
  if (mode === "generate" || mode === "release") {
    if (command === undefined || command.length === 0 || taskId === undefined) usage()
    const baseline = readBaseline()
    const before = auditAgentPlatformWorktree(taskId, baseline)
    if (!before.ok) {
      for (const failure of before.failures) console.error(`✗ ${failure}`)
      process.exit(1)
    }
    process.exit(runIsolated(mode, taskId, command, baseline))
  }
  if (args.length > 0 || (mode === "verify" && command !== undefined)) usage()
  const baseline = readBaseline()
  const before = auditAgentPlatformWorktree(taskId, baseline)
  if (!before.ok) {
    for (const failure of before.failures) console.error(`✗ ${failure}`)
    process.exit(1)
  }
  let commandStatus = 0
  if (command !== undefined && command.length > 0) {
    const result = spawnSync(command, {
      cwd: ROOT,
      shell: true,
      stdio: "inherit",
      env: process.env,
    })
    commandStatus = result.status ?? 1
  }
  const after = auditAgentPlatformWorktree(taskId, baseline)
  if (commandStatus !== 0) process.exit(commandStatus)
  if (!after.ok) {
    for (const failure of after.failures) console.error(`✗ ${failure}`)
    process.exit(1)
  }
  console.log(
    `✓ agent-platform worktree: ${after.changed.length} changed paths, task ${taskId ?? "all"}`,
  )
}
