/**
 * NF-C032: what looks like a credential in browser code or in `public/`, checked from source with the
 * scanner every client build runs (`@nifrajs/web/zones`). The build also matches the values of the
 * build environment's private variables in its output; that needs the build's environment, so it
 * stays the build's.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  publicScanFiles,
  type SecretExemption,
  type SecretScanFile,
  scanForSecrets,
} from "@nifrajs/web/zones"
import { CONFIG_FILE } from "../app-files.ts"
import { stripComments } from "../check-scan.ts"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import type { CheckRule } from "./index.ts"
import { zonedFiles } from "./zones.ts"

const BROWSER_CODE = new Set(["route-frontend", "frontend", "shared"])

const EXEMPTIONS = /\bexport\s+const\s+secretExemptions\b[^=]*=\s*\[([\s\S]*?)\]/
const STRING_FIELD = (name: string): RegExp =>
  new RegExp(`\\b${name}\\s*:\\s*(?:"([^"\\\\\\r\\n]*)"|'([^'\\\\\\r\\n]*)')`)

/**
 * The app's `secretExemptions`, read statically from `nifra.config.ts` (check never imports app code):
 * an array literal of object literals with string fields, the form the build error suggests.
 */
export function readSecretExemptions(appRoot: string): SecretExemption[] {
  const path = join(appRoot, CONFIG_FILE)
  if (!existsSync(path)) return []
  const body = EXEMPTIONS.exec(stripComments(readFileSync(path, "utf8")))?.[1]
  if (body === undefined) return []
  const exemptions: SecretExemption[] = []
  for (const object of body.match(/\{[^{}]*\}/g) ?? []) {
    const field = (name: string): string | undefined => {
      const found = STRING_FIELD(name).exec(object)
      return found === null ? undefined : (found[1] ?? found[2])
    }
    const rule = field("rule")
    const reason = field("reason")
    const file = field("file")
    const env = field("env")
    if (rule === undefined || reason === undefined) continue
    exemptions.push({
      rule: rule as SecretExemption["rule"],
      reason,
      ...(file === undefined ? {} : { file }),
      ...(env === undefined ? {} : { env }),
    })
  }
  return exemptions
}

export const secretSourceRule: CheckRule = {
  code: "NF-C032",
  title: "Credential in browser code",
  async scan(ctx) {
    const { files } = zonedFiles(ctx)
    const apps = new Map<string, SecretScanFile[]>()
    for (const { file, app, classification } of files) {
      if (!apps.has(app)) apps.set(app, [])
      if (!BROWSER_CODE.has(classification.zone)) continue
      const text = ctx.sources.read(file)
      if (text === undefined) continue
      const name = app === "" ? file : file.slice(app.length + 1)
      apps.get(app)?.push({ name, text, firstParty: true })
    }
    const findings: Diagnostic[] = []
    for (const [app, sources] of apps) {
      const appRoot = join(ctx.root, app)
      const publicDir = join(appRoot, "public")
      try {
        const found = scanForSecrets({
          sources,
          artifacts: existsSync(publicDir) ? publicScanFiles(publicDir, "public") : [],
          exemptions: readSecretExemptions(appRoot),
        })
        for (const finding of found) {
          const file = app === "" ? finding.file : `${app}/${finding.file}`
          findings.push(
            diagnostic({
              code: "NF-C032",
              severity: "error",
              file,
              line: finding.line,
              message: `${file} carries what looks like a credential (${finding.what}), and it reaches the browser. Read it from the environment in a route's backend half or under backend/, and rotate it if it was ever committed`,
              evidence: [`rule: ${finding.rule}`, `match: ${finding.preview}`],
              verify: "nifra check",
            }),
          )
        }
      } catch (error) {
        // A malformed exemption: the build refuses it with the same message.
        findings.push(
          diagnostic({
            code: "NF-C032",
            severity: "error",
            file: join(app, CONFIG_FILE),
            message: error instanceof Error ? error.message : String(error),
            verify: "nifra check",
          }),
        )
      }
    }
    return findings.sort(
      (a, b) => (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0),
    )
  },
}

export const secretRules = Object.freeze([secretSourceRule])
