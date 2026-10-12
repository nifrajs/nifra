/** `nifra assure` - evaluate a project's reflected routes against `nifra.assurance.ts`. */

import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { AssuranceConfig, AssuranceReport, AssuredRoute } from "@nifrajs/core/assurance"
import { CONFIG_FILE, FRAMEWORK_FILE } from "./app-files.ts"
import type { Diagnostic } from "./diagnostics.ts"
import type { ProjectVerification } from "./verification.ts"

export interface AssureSink {
  record(bundle: AssureBundle): Promise<void>
}

export interface GateResult {
  readonly gate:
    | "check"
    | "assurance"
    | "doctor"
    | "render"
    | "hydration"
    | "contracts"
    | "size"
    | "tests"
    | string
  readonly status: "pass" | "fail" | "skip"
  readonly skipReason?: string
  readonly durationMs: number
  readonly diagnostics: readonly Diagnostic[]
  readonly replay?: string
}

export interface AssureBundle {
  readonly version: 1
  readonly createdAt: string
  readonly commit: string
  readonly gates: readonly GateResult[]
  readonly verdict: "green" | "red"
}

export interface MemoryAssureSink extends AssureSink {
  readonly bundles: readonly AssureBundle[]
  clear(): void
}

export function createMemoryAssureSink(): MemoryAssureSink {
  const bundles: AssureBundle[] = []
  return {
    record: async (bundle) => {
      bundles.push(bundle)
    },
    get bundles() {
      return Object.freeze([...bundles])
    },
    clear: () => {
      bundles.length = 0
    },
  }
}

export const DEFAULT_ASSURANCE_CONFIG = "nifra.assurance.ts"

const displayPath = (path: string): string => path.replaceAll("\\", "/")

function isConfig(value: unknown): value is AssuranceConfig {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<AssuranceConfig>
  return (
    candidate.source !== undefined &&
    typeof candidate.policy === "object" &&
    candidate.policy !== null
  )
}

export async function loadAssuranceConfig(
  cwd: string,
  configPath = DEFAULT_ASSURANCE_CONFIG,
): Promise<AssuranceConfig> {
  const path = resolve(cwd, configPath)
  if (!existsSync(path)) {
    throw new Error(
      `[nifra] route assurance config not found: ${displayPath(path)} - create ${DEFAULT_ASSURANCE_CONFIG} with a default defineAssuranceConfig({ source, policy }) export.`,
    )
  }
  const specifier = pathToFileURL(path)
  specifier.searchParams.set("nifra-assurance", String(Date.now()))
  const loaded = (await import(specifier.href)) as { default?: unknown }
  if (!isConfig(loaded.default)) {
    throw new Error(
      `[nifra] ${displayPath(path)} must default-export defineAssuranceConfig({ source, policy }).`,
    )
  }
  return loaded.default
}

/** Why declared response/error schemas go unenforced, phrased for the server that has to change. */
export interface ResponseContractGaps {
  readonly typedOnly: readonly string[]
  readonly warnOnly: readonly string[]
  readonly typedOnlyReason: string | undefined
  readonly warnOnlyReason: string | undefined
}

const sample = (routes: readonly string[]): string =>
  routes.length <= 3
    ? routes.join(", ")
    : `${routes.slice(0, 3).join(", ")} and ${routes.length - 3} more`

export function responseContractGaps(routes: readonly AssuredRoute[]): ResponseContractGaps {
  const key = (route: AssuredRoute): string => `${route.method} ${route.path}`
  const typedOnly = routes.filter((route) => route.responseContract === "unchecked").map(key)
  const warnOnly = routes.filter((route) => route.responseContract === "warn").map(key)
  const covered = routes.filter(
    (route) => route.responseContract === "enforce" || route.responseContract === "warn",
  ).length
  // A plugin that covers some routes is installed - just not where these were registered, which is
  // the case "install responseContract" advice used to send people in circles over.
  const typedOnlyReason =
    typedOnly.length === 0
      ? undefined
      : covered > 0
        ? `${typedOnly.length} declared route(s) are typed-only (${sample(typedOnly)}) although responseContract() covers ${covered} other(s): it covers routes registered after it on the same server, and routes merge()d into that server after it. Install responseContract("enforce") on the server that registers these, before them.`
        : `${typedOnly.length} declared route(s) are typed-only (${sample(typedOnly)}); install responseContract("enforce") on the server that registers them, before them - a parent's also covers servers merge()d into it afterwards.`
  const warnOnlyReason =
    warnOnly.length === 0
      ? undefined
      : `${warnOnly.length} declared route(s) are warn-only and still send the original payload (${sample(warnOnly)}); switch responseContract("warn") to "enforce".`
  return { typedOnly, warnOnly, typedOnlyReason, warnOnlyReason }
}

/** The policy line that turns an unenforced contract into a route-assurance failure. */
export const RESPONSE_CONTRACT_BASELINE_HINT =
  'to fail route assurance on these, add baseline: [{ name: "response-contract", match: { hasResponse: true }, require: ["nifra.response-contract"] }] to the policy'

export function formatAssuranceReport(report: AssuranceReport): string {
  if (report.ok) {
    const contracted = report.routes.filter((route) => route.responseContract !== undefined)
    const enforced = contracted.filter((route) => route.responseContract === "enforce").length
    const warned = contracted.filter((route) => route.responseContract === "warn").length
    const unchecked = contracted.filter((route) => route.responseContract === "unchecked").length
    const runtimeContract =
      contracted.length === 0
        ? " No declared response/error schemas were found."
        : " Runtime response contracts: " +
          enforced +
          " enforced, " +
          warned +
          " warn-only, " +
          unchecked +
          " typed-only."
    const capability = report.capabilities
      ? ` Capability assurance covered ${report.capabilities.routes.length} route${report.capabilities.routes.length === 1 ? "" : "s"}.`
      : ""
    return `✓ route assurance: ${report.routes.length} route${report.routes.length === 1 ? "" : "s"} classified; all required evidence is present.${capability}${runtimeContract}`
  }
  const messages = [
    ...report.findings.map((finding) => finding.message),
    ...(report.capabilities?.findings.map((finding) => finding.message) ?? []),
  ]
  return `${messages.map((message) => `✖ ${message}`).join("\n")}\n\n${messages.length} assurance failure${messages.length === 1 ? "" : "s"} across ${report.routes.length} route${report.routes.length === 1 ? "" : "s"}.`
}

export async function collectAssuranceReport(
  cwd: string,
  configPath?: string,
): Promise<AssuranceReport> {
  // The route-assurance view over the one project verification. The config load, route reflection, and
  // capability walk it needs are exactly what `collectProjectVerification` already ran.
  const { collectProjectVerification } = await import("./verification.ts")
  const verification = await collectProjectVerification(cwd, {
    ...(configPath !== undefined ? { config: configPath } : {}),
  })
  // A missing/broken config threw here before; re-throw the same error to keep that contract.
  if (verification.configError !== undefined) throw verification.configError
  // A present config means routeAssurance is computed; capability is set exactly when the config
  // declares a capabilities policy.
  const routeReport = verification.routeAssurance as AssuranceReport
  if (verification.capability === undefined) return routeReport
  return Object.freeze({
    ...routeReport,
    ok: routeReport.ok && verification.capability.report.ok,
    capabilities: verification.capability.report,
  })
}

export async function runAssurance(
  cwd: string,
  options: {
    readonly json?: boolean
    readonly config?: string
    readonly bundle?: boolean
    readonly strict?: boolean
    readonly out?: string
    readonly hydration?: boolean
    readonly interact?: boolean
  } = {},
): Promise<boolean> {
  if (options.bundle === true) {
    const bundle = await collectAssureBundle(cwd, options)
    const serialized = JSON.stringify(bundle, null, 2)
    if (options.out !== undefined) await Bun.write(resolve(cwd, options.out), `${serialized}\n`)
    else console.log(serialized)
    return bundle.verdict === "green"
  }
  const report = await collectAssuranceReport(cwd, options.config)
  console.log(
    options.json === true ? JSON.stringify(report, null, 2) : formatAssuranceReport(report),
  )
  return report.ok
}

function elapsed(start: number): number {
  return Math.max(0, Math.round(performance.now() - start))
}

async function gitCommit(cwd: string): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe", stderr: "ignore" })
    const text = (await new Response(proc.stdout).text()).trim()
    await proc.exited
    return text || "unknown"
  } catch {
    return "unknown"
  }
}

function diagnosticFromMessage(
  code: string,
  message: string,
  severity: "error" | "warn" | "info" = "error",
): Diagnostic {
  return Object.freeze({ code, severity, message })
}

function statusFor(diagnostics: readonly Diagnostic[], strict: boolean): "pass" | "fail" {
  return diagnostics.some(
    (item) => item.severity === "error" || (strict && item.severity === "warn"),
  )
    ? "fail"
    : "pass"
}

export async function collectAssureBundle(
  cwd: string,
  options: {
    readonly config?: string
    readonly strict?: boolean
    readonly hydration?: boolean
    readonly interact?: boolean
  } = {},
): Promise<AssureBundle> {
  const strict = options.strict === true
  const gates: GateResult[] = []
  let assuranceConfig: AssuranceConfig | undefined
  let assuranceConfigError: unknown
  try {
    assuranceConfig = await loadAssuranceConfig(cwd, options.config)
  } catch (error) {
    assuranceConfigError = error
  }
  const addGate = async (
    gate: GateResult["gate"],
    run: () => Promise<{ diagnostics: Diagnostic[]; skipReason?: string; replay?: string }>,
  ): Promise<void> => {
    const start = performance.now()
    try {
      const result = await run()
      gates.push({
        gate,
        status: result.skipReason === undefined ? statusFor(result.diagnostics, strict) : "skip",
        ...(result.skipReason === undefined ? {} : { skipReason: result.skipReason }),
        durationMs: elapsed(start),
        diagnostics: Object.freeze(result.diagnostics),
        ...(result.replay === undefined ? {} : { replay: result.replay }),
      })
    } catch (error) {
      gates.push({
        gate,
        status: "fail",
        durationMs: elapsed(start),
        diagnostics: [
          diagnosticFromMessage(
            gate === "contracts" ? "NF-K001" : gate === "hydration" ? "NF-H001" : "NF-A001",
            error instanceof Error ? error.message : String(error),
          ),
        ],
      })
    }
  }

  // One verification serves both gates that read the app, so the config is evaluated once.
  let verification: Promise<ProjectVerification> | undefined
  const verify = (): Promise<ProjectVerification> =>
    (verification ??= import("./verification.ts").then(({ collectProjectVerification }) =>
      collectProjectVerification(cwd, {
        ...(options.config !== undefined ? { config: options.config } : {}),
        preloaded:
          assuranceConfig !== undefined
            ? { config: assuranceConfig }
            : { error: assuranceConfigError },
      }),
    ))

  await addGate("check", async () => {
    const result = await (await verify()).check()
    const diagnostics = (result.structuredDiagnostics ?? []).map((item) => item)
    return { diagnostics }
  })

  // Route assurance is the gate the bundle exists to carry: a failing policy fails it, and a declared
  // response the runtime does not enforce is a warning, so `--strict` refuses to call it green.
  await addGate("assurance", async () => {
    const report = assuranceConfig === undefined ? undefined : (await verify()).routeAssurance
    if (report === undefined)
      return {
        diagnostics: [],
        skipReason: existsSync(resolve(cwd, options.config ?? DEFAULT_ASSURANCE_CONFIG))
          ? "route assurance could not be evaluated (reported by the check gate)"
          : "no route assurance config",
      }
    const diagnostics = report.findings.map((finding) =>
      diagnosticFromMessage("NF-A001", finding.message, "error"),
    )
    const gaps = responseContractGaps(report.routes)
    for (const [reason, routes] of [
      [gaps.typedOnlyReason, gaps.typedOnly],
      [gaps.warnOnlyReason, gaps.warnOnly],
    ] as const) {
      if (reason === undefined) continue
      diagnostics.push(
        Object.freeze({
          code: "NF-A001",
          severity: "warn" as const,
          message: `${reason} (${RESPONSE_CONTRACT_BASELINE_HINT})`,
          evidence: Object.freeze(routes.slice(0, 20)),
        }),
      )
    }
    return { diagnostics }
  })

  await addGate("doctor", async () => {
    const { collectDoctorResult } = await import("./doctor.ts")
    const result = await collectDoctorResult(cwd)
    const diagnostics: Diagnostic[] = []
    for (const finding of result.findings) {
      diagnostics.push(
        diagnosticFromMessage(
          "NF-D001",
          `imports ${finding.package} which is not declared`,
          "error",
        ),
      )
    }
    for (const finding of result.duplicateInstalls) {
      diagnostics.push(
        diagnosticFromMessage("NF-D001", `${finding.package} resolves to duplicate installs`),
      )
    }
    return { diagnostics }
  })

  await addGate("contracts", async () => {
    const { checkContractsLock } = await import("./contracts.ts")
    const path = resolve(cwd, "contracts.lock.json")
    if (!existsSync(path)) return { diagnostics: [], skipReason: "no contract lock configured" }
    const result = await checkContractsLock(cwd)
    return {
      diagnostics: result.diagnostics.map((item) =>
        diagnosticFromMessage("NF-K001", item.message, "error"),
      ),
    }
  })

  await addGate("render", async () => {
    if (!existsSync(join(cwd, CONFIG_FILE)) && !existsSync(join(cwd, FRAMEWORK_FILE)))
      return { diagnostics: [], skipReason: "no client render target configured" }
    const { renderPages } = await import("./mcp-render.ts")
    const result = await renderPages(cwd, [{ path: "/" }])
    if ("error" in result)
      return {
        diagnostics: [diagnosticFromMessage("NF-A001", "SSR render gate failed", "error")],
      }
    const pages = Array.isArray(result.results) ? result.results : []
    const failure = pages.find(
      (page): page is { status?: unknown } =>
        typeof page === "object" &&
        page !== null &&
        Number((page as { status?: unknown }).status) >= 500,
    )
    return failure === undefined
      ? { diagnostics: [] }
      : { diagnostics: [diagnosticFromMessage("NF-A001", "SSR render returned a server error")] }
  })
  await addGate("size", async () => {
    const budget = assuranceConfig?.size
    if (
      budget === undefined ||
      (budget.maxBytes === undefined && budget.maxGzipBytes === undefined)
    )
      return { diagnostics: [], skipReason: "no size budget configured" }
    const outDir = resolve(cwd, budget.outDir ?? "dist")
    if (!existsSync(outDir))
      return {
        diagnostics: [diagnosticFromMessage("NF-A001", "size gate output directory is missing")],
      }
    const files: string[] = []
    for await (const file of new Bun.Glob("**/*").scan({ cwd: outDir, onlyFiles: true }))
      files.push(join(outDir, file))
    let bytes = 0
    let gzipBytes = 0
    for (const file of files) {
      const data = await Bun.file(file).bytes()
      bytes += data.byteLength
      gzipBytes += Bun.gzipSync(data).byteLength
    }
    const overRaw = budget.maxBytes !== undefined && bytes > budget.maxBytes
    const overGzip = budget.maxGzipBytes !== undefined && gzipBytes > budget.maxGzipBytes
    return {
      diagnostics:
        overRaw || overGzip
          ? [
              diagnosticFromMessage(
                "NF-A001",
                `output exceeds configured size budget (${bytes} bytes, ${gzipBytes} gzip bytes)`,
              ),
            ]
          : [],
    }
  })
  if (options.hydration === true) {
    await addGate("hydration", async () => {
      const { runHydrationAssurance } = await import("./assure-hydration.ts")
      const result = await runHydrationAssurance(cwd, { interact: options.interact === true })
      return {
        diagnostics: [...result.diagnostics],
        ...(result.skipReason === undefined ? {} : { skipReason: result.skipReason }),
        ...(result.replays?.[0] === undefined ? {} : { replay: result.replays[0] }),
      }
    })
  } else {
    await addGate("hydration", async () => ({
      diagnostics: [],
      skipReason: "pass --hydration to run the hydration gate",
    }))
  }
  const workloads = assuranceConfig?.idempotency ?? []
  const testGateStart = performance.now()
  if (workloads.length === 0) {
    gates.push({
      gate: "tests",
      status: "skip",
      skipReason: "no idempotency workloads configured",
      durationMs: elapsed(testGateStart),
      diagnostics: [],
    })
  } else {
    const { proveIdempotency } = await import("@nifrajs/testing")
    const diagnostics: Diagnostic[] = []
    for (const workload of workloads) {
      const proof = await proveIdempotency({ run: workload.run })
      for (const divergence of proof.divergences) {
        diagnostics.push(
          diagnosticFromMessage(
            "NF-A001",
            `${workload.name} diverged at step ${divergence.step} field ${divergence.field}`,
            "error",
          ),
        )
      }
    }
    gates.push({
      gate: "tests",
      status: statusFor(diagnostics, strict),
      durationMs: elapsed(testGateStart),
      diagnostics,
    })
  }
  const bundle: AssureBundle = Object.freeze({
    version: 1,
    createdAt: new Date().toISOString(),
    commit: await gitCommit(cwd),
    gates: Object.freeze(gates),
    verdict: gates.some((gate) => gate.status === "fail") ? "red" : "green",
  })
  const sink = assuranceConfig?.assureSink
  if (
    typeof sink === "object" &&
    sink !== null &&
    "record" in sink &&
    typeof sink.record === "function"
  ) {
    await sink.record(bundle)
  }
  return bundle
}
