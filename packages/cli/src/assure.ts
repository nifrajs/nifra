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
    return `✓ route assurance: ${report.routes.length} route${report.routes.length === 1 ? "" : "s"} classified; all required evidence is present.`
  }
  const lines = report.findings.map((finding) => `✖ ${finding.message}`)
  return `${lines.join("\n")}\n\n${report.findings.length} route assurance failure${report.findings.length === 1 ? "" : "s"} across ${report.routes.length} route${report.routes.length === 1 ? "" : "s"}.`
}

export async function collectAssuranceReport(
  cwd: string,
  configPath?: string,
): Promise<AssuranceReport> {
  const config = await loadAssuranceConfig(cwd, configPath)
  return evaluateRouteAssurance(config.source, config.policy)
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
