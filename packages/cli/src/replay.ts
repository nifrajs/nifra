import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { type CompatibleReplayFile, parseCompatibleReplayFile } from "@nifrajs/core/replay"
import { runHydrationAssurance } from "./assure-hydration.ts"
import { checkContractsLock } from "./contracts.ts"

export interface ReplayResult {
  readonly ok: boolean
  readonly replay: CompatibleReplayFile
  readonly compatible?: boolean
  readonly error?: string
  readonly diagnostics?: readonly unknown[]
  readonly replays?: readonly string[]
}

const within = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return !rel.startsWith("..") && !isAbsolute(rel)
}

const canonical = (path: string): Promise<string> => realpath(path).catch(() => path)

/** Validate and dispatch one token-only replay while keeping the file inside the project root. */
export async function runReplay(cwd: string, file: string): Promise<ReplayResult> {
  const root = resolve(cwd)
  // Compared as real paths: the MCP host hands over an already-resolved file, which never starts
  // with a root reached through a symlink, and a replay file that is itself a link must not lead out.
  const path = await canonical(resolve(root, file))
  if (!within(await canonical(root), path) && !within(root, path)) {
    throw new Error("replay file must stay inside the project root")
  }
  const replay = parseCompatibleReplayFile(JSON.parse(await Bun.file(path).text()))
  if ("gate" in replay && replay.gate === "hydration") {
    const hydration = await runHydrationAssurance(cwd, {
      seed: replay.seed,
      ...(replay.case.startsWith("/") ? { routes: [replay.case] } : {}),
    })
    return {
      ok: hydration.diagnostics.length === 0,
      replay,
      diagnostics: hydration.diagnostics,
      ...(hydration.replays === undefined ? {} : { replays: hydration.replays }),
    }
  }
  if ("gate" in replay && replay.gate === "contracts") {
    const contracts = await checkContractsLock(cwd)
    return {
      ok: contracts.present && contracts.diagnostics.length === 0,
      replay,
      diagnostics: contracts.diagnostics,
    }
  }
  if (!("gate" in replay)) return { ok: true, replay, compatible: true }
  return { ok: false, replay, error: `no replay dispatcher for gate ${replay.gate}` }
}
