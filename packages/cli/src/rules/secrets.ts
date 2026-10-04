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
import { codeUnitOrder } from "../internal/code-unit-order.ts"
import type { CheckRule } from "./index.ts"
import { zonedFiles } from "./zones.ts"

const BROWSER_CODE = new Set(["route-frontend", "frontend", "shared"])

const EXEMPTIONS_START = /\bexport\s+const\s+secretExemptions\b[^=]*=\s*\[/

type Token = { readonly kind: "string" | "word" | "punct"; readonly value: string }

/**
 * The tokens of an array literal, from just after its `[` to the `]` that closes it. A string is one
 * token, so a bracket or a colon inside one (`"routes/[lang]/index.tsx"`) is text, never syntax.
 */
function arrayTokens(src: string, from: number): Token[] {
  const tokens: Token[] = []
  let depth = 0
  let i = from
  while (i < src.length) {
    const c = src[i] as string
    if (c === '"' || c === "'" || c === "`") {
      let value = ""
      let j = i + 1
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") {
          value += src[j + 1] ?? ""
          j += 2
        } else value += src[j++]
      }
      tokens.push({ kind: "string", value })
      i = j + 1
    } else if (/[\w$]/.test(c)) {
      let j = i
      while (j < src.length && /[\w$]/.test(src[j] as string)) j++
      tokens.push({ kind: "word", value: src.slice(i, j) })
      i = j
    } else {
      if (c === "]" || c === "}" || c === ")") {
        if (depth === 0) break
        depth--
      } else if (c === "[" || c === "{" || c === "(") depth++
      if (!/\s/.test(c)) tokens.push({ kind: "punct", value: c })
      i++
    }
  }
  return tokens
}

const isPunct = (token: Token | undefined, value: string): boolean =>
  token?.kind === "punct" && token.value === value

/**
 * The app's `secretExemptions`, read statically from `nifra.config.ts` (check never imports app code):
 * an array literal of object literals with string fields, the form the build error suggests.
 */
export function readSecretExemptions(appRoot: string): SecretExemption[] {
  const path = join(appRoot, CONFIG_FILE)
  if (!existsSync(path)) return []
  const text = stripComments(readFileSync(path, "utf8"))
  const opened = EXEMPTIONS_START.exec(text)
  if (opened === null) return []
  const tokens = arrayTokens(text, opened.index + opened[0].length)
  const exemptions: SecretExemption[] = []
  let depth = 0
  let fields: Record<string, string> | undefined
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token
    if (token.kind === "punct" && "[{(".includes(token.value)) {
      depth++
      if (depth === 1 && token.value === "{") fields = {}
    } else if (token.kind === "punct" && "]})".includes(token.value)) {
      if (depth === 1 && fields !== undefined) {
        const { rule, reason, file, env } = fields
        if (rule !== undefined && reason !== undefined) {
          exemptions.push({
            rule: rule as SecretExemption["rule"],
            reason,
            ...(file === undefined ? {} : { file }),
            ...(env === undefined ? {} : { env }),
          })
        }
        fields = undefined
      }
      depth--
    } else if (
      depth === 1 &&
      fields !== undefined &&
      token.kind !== "punct" &&
      isPunct(tokens[i + 1], ":") &&
      tokens[i + 2]?.kind === "string" &&
      (isPunct(tokens[i + 3], ",") || isPunct(tokens[i + 3], "}"))
    ) {
      fields[token.value] ??= (tokens[i + 2] as Token).value
      i += 2
    }
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
      (a, b) => codeUnitOrder(a.file ?? "", b.file ?? "") || (a.line ?? 0) - (b.line ?? 0),
    )
  },
}

export const secretRules = Object.freeze([secretSourceRule])
