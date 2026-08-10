import { resolve, sep } from "node:path"
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

/** Validate and dispatch one token-only replay while keeping the file inside the project root. */
export async function runReplay(cwd: string, file: string): Promise<ReplayResult> {
  const path = resolve(cwd, file)
  if (path !== cwd && !path.startsWith(cwd + sep)) {
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
