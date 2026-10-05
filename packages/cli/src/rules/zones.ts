/**
 * NF-C028 and NF-C029: the frontend/backend zone rules, checked from source.
 *
 * Every browser build and dev server enforces these already; this reports them without building,
 * with the same classifier (`@nifrajs/web/zones`) so the three can never disagree. NF-C004 owns
 * browser code reaching server code (with the chain); NF-C028 owns the other directions: a zoned
 * file importing one in no zone, backend code importing frontend code, and shared code importing
 * anything but shared code. NF-C029 owns private environment reads in browser code.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative } from "node:path"
import {
  type Classification,
  createZoneClassifier,
  importAllowed,
  importRuleMessage,
  privateEnvReads,
  privateEnvReason,
  type ZoneClassifier,
} from "@nifrajs/web/zones"
import { CONFIG_FILE, FRAMEWORK_FILE } from "../app-files.ts"
import { importSites, stripComments } from "../check-scan.ts"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { codeUnitOrder } from "../internal/code-unit-order.ts"
import type { CheckRule, RuleContext } from "./index.ts"

const ZONE_FOLDER = new Set(["routes", "frontend", "backend", "shared"])
const FRONTEND = new Set(["route-frontend", "frontend"])
const SERVER = new Set(["backend", "route-backend", "fn"])
const BACKEND = new Set(["backend", "route-backend"])
const BROWSER_CODE = new Set(["route-frontend", "frontend", "shared"])
const CODE_FILE = /\.(?:[cm]?[jt]sx?|svelte|vue|mdx)$/

/** The app a project file belongs to: the path before its first zone folder, or `undefined`. */
function appOf(file: string): string | undefined {
  const parts = file.split("/")
  const at = parts.findIndex((part, i) => i < parts.length - 1 && ZONE_FOLDER.has(part))
  return at === -1 ? undefined : parts.slice(0, at).join("/")
}

interface ZonedFile {
  readonly file: string
  readonly app: string
  readonly classification: Classification
}

/** Every scanned source file that belongs to an app, classified once per app classifier. */
export function zonedFiles(ctx: RuleContext): {
  readonly files: readonly ZonedFile[]
  readonly classifierFor: (app: string) => ZoneClassifier
} {
  const classifiers = new Map<string, ZoneClassifier>()
  const classifierFor = (app: string): ZoneClassifier => {
    let classifier = classifiers.get(app)
    if (classifier === undefined) {
      const appRoot = join(ctx.root, app)
      classifier = createZoneClassifier({
        appRoot,
        generatedFiles: [join(appRoot, "server-manifest.ts")],
      })
      classifiers.set(app, classifier)
    }
    return classifier
  }
  const files: ZonedFile[] = []
  for (const file of ctx.sources.files) {
    if (!CODE_FILE.test(file)) continue
    const app = appOf(file)
    if (app === undefined) continue
    files.push({ file, app, classification: classifierFor(app).classify(join(ctx.root, file)) })
  }
  return { files, classifierFor }
}

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Where a resolved import lands, as the project names it. Both sides are real paths: a checkout
 * reached through a symlink (`/var` -> `/private/var` on macOS) still names files project-relative. */
function display(root: string, file: string): string {
  const rel = relative(real(root), real(file)).replaceAll("\\", "/")
  return rel.startsWith("../") || isAbsolute(rel) ? file : rel
}

/** A relative import resolved against the importing file, or `undefined` when it does not resolve. */
function resolveRelative(root: string, from: string, specifier: string): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined
  try {
    // Relative specifiers only: a bare one would let the resolver reach for a global install.
    return Bun.resolveSync(specifier, dirname(join(root, from)))
  } catch {
    return undefined
  }
}

export const zoneImportRule: CheckRule = {
  code: "NF-C028",
  title: "Zone import check",
  async scan(ctx) {
    const { files, classifierFor } = zonedFiles(ctx)
    const findings: Diagnostic[] = []
    for (const { file, app, classification: from } of files) {
      if (from.zone === "error" || from.zone === "library" || from.zone === "generated") continue
      const content = ctx.sources.read(file)
      if (content === undefined) continue
      for (const { specifier, line } of importSites(content, file)) {
        const target = resolveRelative(ctx.root, file, specifier)
        if (target === undefined) continue
        const to = classifierFor(app).classify(target)
        const targetName = display(ctx.root, target)
        let message: string
        if (to.zone === "error") message = `${file} imports ${targetName}: ${to.reason}`
        else if (
          (SERVER.has(from.zone) && FRONTEND.has(to.zone)) ||
          // Shared code reaching backend code is NF-C004's, reported there with the chain.
          (from.zone === "shared" && !importAllowed(from.zone, to.zone) && !BACKEND.has(to.zone))
        ) {
          message = importRuleMessage(file, from.zone, targetName, to.zone)
        } else continue
        findings.push(
          diagnostic({
            code: "NF-C028",
            severity: "error",
            file,
            line,
            message,
            evidence: [`import: ${specifier}`, `from zone: ${from.zone}`, `to zone: ${to.zone}`],
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

const PREFIX_EXPORT =
  /\bexport\s+const\s+publicEnvPrefix\s*(?::\s*string\s*)?=\s*(?:"([^"\\\r\n]*)"|'([^'\\\r\n]*)')/

/** The app's public-env prefix when its config declares it as a string literal, else the default. */
function publicPrefix(root: string, app: string): string {
  for (const config of [FRAMEWORK_FILE, CONFIG_FILE]) {
    const path = join(root, app, config)
    if (!existsSync(path)) continue
    const match = PREFIX_EXPORT.exec(stripComments(readFileSync(path, "utf8")))
    if (match !== null) return match[1] ?? match[2] ?? "PUBLIC_"
  }
  return "PUBLIC_"
}

export const privateEnvRule: CheckRule = {
  code: "NF-C029",
  title: "Private environment read in browser code",
  async scan(ctx) {
    const { files } = zonedFiles(ctx)
    const prefixes = new Map<string, string>()
    const findings: Diagnostic[] = []
    for (const { file, app, classification } of files) {
      if (!BROWSER_CODE.has(classification.zone)) continue
      const content = ctx.sources.read(file)
      if (content === undefined) continue
      let prefix = prefixes.get(app)
      if (prefix === undefined) {
        prefix = publicPrefix(ctx.root, app)
        prefixes.set(app, prefix)
      }
      const reads = privateEnvReads(file, content, prefix)
      if (reads.length === 0) continue
      const first = reads[0] ?? ""
      const name = /[.[(]["']?([A-Za-z_$][\w$]*)["']?[)\]]?$/.exec(first)?.[1]
      const index = name === undefined ? -1 : content.indexOf(name)
      findings.push(
        diagnostic({
          code: "NF-C029",
          severity: "error",
          file,
          ...(index === -1 ? {} : { line: content.slice(0, index).split("\n").length }),
          message: `${file} ${privateEnvReason(reads, prefix)}`,
          evidence: reads.map((read) => `read: ${read}`),
          verify: "nifra check",
        }),
      )
    }
    return findings
  },
}

export const zoneRules = Object.freeze([zoneImportRule, privateEnvRule])
