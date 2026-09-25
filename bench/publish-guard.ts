import { cpus, loadavg } from "node:os"

export interface BenchRuntimeVersions {
  readonly bun: string
  readonly node: string
  readonly deno: string
}

const PIN_FILE = new URL("../.tool-versions", import.meta.url)
const MAX_LOAD_PER_CPU = 0.5

function commandVersion(command: string, arg: string): string {
  try {
    const result = Bun.spawnSync([command, arg])
    if (!result.success) return "unavailable"
    const first = new TextDecoder().decode(result.stdout).trim().split(/\r?\n/)[0]?.trim()
    if (!first) return "unavailable"
    if (command === "deno") return first.split(/\s+/)[1] ?? "unavailable"
    return first.replace(/^v/, "")
  } catch {
    return "unavailable"
  }
}

export function activeBenchRuntimeVersions(): BenchRuntimeVersions {
  return {
    bun: Bun.version,
    node: commandVersion("node", "--version"),
    deno: commandVersion("deno", "--version"),
  }
}

function normalized(version: string): string {
  return version.trim().replace(/^v/, "")
}

/** Prevent release benchmark files from being written with unpinned or heavily contended runs. */
export async function assertBenchmarkPublishable(
  versions: BenchRuntimeVersions = activeBenchRuntimeVersions(),
): Promise<void> {
  const pinText = await Bun.file(PIN_FILE).text()
  const pins = new Map<string, string>()
  for (const line of pinText.split(/\r?\n/)) {
    const [name, version] = line.trim().split(/\s+/)
    if (name && version) pins.set(name, version)
  }
  const expected = {
    bun: pins.get("bun"),
    node: pins.get("nodejs"),
    deno: pins.get("deno"),
  }
  const problems: string[] = []

  for (const runtime of ["bun", "node", "deno"] as const) {
    const pin = expected[runtime]
    const actual = normalized(versions[runtime])
    if (!pin) {
      problems.push(`.tool-versions is missing the ${runtime} pin`)
    } else if (actual !== normalized(pin)) {
      problems.push(`${runtime} is ${actual}; .tool-versions pins ${pin}`)
    }
  }

  if (process.platform !== "win32") {
    const cpuCount = cpus().length
    const oneMinuteLoad = loadavg()[0] ?? Number.NaN
    if (cpuCount === 0 || !Number.isFinite(oneMinuteLoad)) {
      problems.push("host load could not be measured")
    } else if (oneMinuteLoad > cpuCount * MAX_LOAD_PER_CPU) {
      problems.push(
        `1-minute load is ${oneMinuteLoad.toFixed(2)} for ${cpuCount} CPUs ` +
          `(limit ${MAX_LOAD_PER_CPU.toFixed(2)} per CPU)`,
      )
    }
  }

  if (problems.length > 0) {
    throw new Error(`refusing to write benchmark results: ${problems.join("; ")}`)
  }
}
