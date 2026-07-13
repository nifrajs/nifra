/** `nifra assure` — evaluate a project's reflected routes against `nifra.assurance.ts`. */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  type AssuranceConfig,
  type AssuranceReport,
  evaluateRouteAssurance,
} from "@nifrajs/core/assurance"

export const DEFAULT_ASSURANCE_CONFIG = "nifra.assurance.ts"

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
      `[nifra] route assurance config not found: ${path} — create ${DEFAULT_ASSURANCE_CONFIG} with a default defineAssuranceConfig({ source, policy }) export.`,
    )
  }
  const specifier = pathToFileURL(path)
  specifier.searchParams.set("nifra-assurance", String(Date.now()))
  const loaded = (await import(specifier.href)) as { default?: unknown }
  if (!isConfig(loaded.default)) {
    throw new Error(
      `[nifra] ${path} must default-export defineAssuranceConfig({ source, policy }).`,
    )
  }
  return loaded.default
}

export function formatAssuranceReport(report: AssuranceReport): string {
  if (report.ok) {
    const capability = report.capabilities
      ? ` Capability assurance covered ${report.capabilities.routes.length} route${report.capabilities.routes.length === 1 ? "" : "s"}.`
      : ""
    return `✓ route assurance: ${report.routes.length} route${report.routes.length === 1 ? "" : "s"} classified; all required evidence is present.${capability}`
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
  const config = await loadAssuranceConfig(cwd, configPath)
  const routeReport = evaluateRouteAssurance(config.source, config.policy)
  if (config.capabilities === undefined) return routeReport
  const { collectCapabilityProjectReport } = await import("./capabilities-tool.ts")
  const capabilityProject = await collectCapabilityProjectReport(
    cwd,
    config.source,
    config.capabilities,
  )
  return Object.freeze({
    ...routeReport,
    ok: routeReport.ok && capabilityProject.report.ok,
    capabilities: capabilityProject.report,
  })
}

export async function runAssurance(
  cwd: string,
  options: { readonly json?: boolean; readonly config?: string } = {},
): Promise<boolean> {
  const report = await collectAssuranceReport(cwd, options.config)
  console.log(
    options.json === true ? JSON.stringify(report, null, 2) : formatAssuranceReport(report),
  )
  return report.ok
}
