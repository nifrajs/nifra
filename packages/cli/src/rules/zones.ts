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
import { isAbsolute, join, relative } from "node:path"
import {
  browserDenial,
  type Classification,
  createZoneClassifier,
  importAllowed,
  importRuleMessage,
  privateEnvReads,
  privateEnvReason,
  type ZoneClassifier,
  ZoneConfigError,
} from "@nifrajs/web/zones"
import { CONFIG_FILE, FRAMEWORK_FILE } from "../app-files.ts"
import { importSites, stripComments } from "../check-scan.ts"
import { appDirs, clientModuleRoot } from "../client-module.ts"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { codeUnitOrder } from "../internal/code-unit-order.ts"
import { createNifraProjectProbe } from "../internal/nifra-project.ts"
import { createSpecifierResolver } from "../internal/project-specifiers.ts"
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
  /** Apps whose `nifra.zones` setting is invalid; their files are left out of `files`. */
  readonly configErrors: ReadonlyArray<{ readonly app: string; readonly message: string }>
} {
  const classifiers = new Map<string, ZoneClassifier | ZoneConfigError>()
  const load = (app: string): ZoneClassifier | ZoneConfigError => {
    let classifier = classifiers.get(app)
    if (classifier === undefined) {
      const appRoot = join(ctx.root, app)
      try {
        classifier = createZoneClassifier({
          appRoot,
          generatedFiles: [join(appRoot, "server-manifest.ts")],
        })
      } catch (error) {
        if (!(error instanceof ZoneConfigError)) throw error
        classifier = error
      }
      classifiers.set(app, classifier)
    }
    return classifier
  }
  const classifierFor = (app: string): ZoneClassifier => {
    const classifier = load(app)
    if (classifier instanceof ZoneConfigError) throw classifier
    return classifier
  }
  const files: ZonedFile[] = []
  const configErrors: Array<{ app: string; message: string }> = []
  // Another framework's app keeps folders named `routes/` too; nifra builds none of it.
  const inNifraProject = createNifraProjectProbe(ctx.root)
  for (const file of ctx.sources.files) {
    if (!CODE_FILE.test(file)) continue
    const app = appOf(file)
    if (app === undefined || !inNifraProject(app)) continue
    const classifier = load(app)
    if (classifier instanceof ZoneConfigError) {
      if (!configErrors.some((entry) => entry.app === app))
        configErrors.push({ app, message: classifier.message })
      continue
    }
    files.push({ file, app, classification: classifier.classify(join(ctx.root, file)) })
  }
  return { files, classifierFor, configErrors }
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

// The unzoned files one check follows through, at most: each is a build refusal of its own.
const MAX_UNZONED = 5000

interface Importer {
  readonly file: string
  readonly app: string
  /** `"error"` for a file in no zone, reached from code a build loads. */
  readonly zone: Classification["zone"]
}

export const zoneImportRule: CheckRule = {
  code: "NF-C028",
  title: "Zone import check",
  async scan(ctx) {
    const { files, classifierFor, configErrors } = zonedFiles(ctx)
    const receipts = ctx.sources.files.some((file) =>
      /\.component\.server\.[cm]?[jt]sx?$/.test(file),
    )
      ? (await import("../component-check.ts")).componentCheckReceipts(ctx.root, ctx.sources)
      : new Set<string>()
    const findings: Diagnostic[] = configErrors.map(({ app, message }) =>
      diagnostic({
        code: "NF-C028",
        severity: "error",
        file: app === "" ? "package.json" : `${app}/package.json`,
        message,
        verify: "nifra check",
      }),
    )
    const resolveSpecifier = createSpecifierResolver()
    const queue: Importer[] = []
    const queued = new Set<string>()
    const follow = (importer: Importer): void => {
      if (queued.has(importer.file) || queued.size >= MAX_UNZONED + files.length) return
      queued.add(importer.file)
      queue.push(importer)
    }
    for (const { file, app, classification } of files) {
      const zone = classification.zone
      if (zone !== "error" && zone !== "library" && zone !== "generated")
        follow({ file, app, zone })
    }
    // The browser entry imports the app's `clientModule`, so the build classifies it like any file it
    // loads, and loads what it imports.
    for (const app of appDirs(ctx.sources.files)) {
      const entry = clientModuleRoot(ctx.root, app, resolveSpecifier)
      if (entry === undefined) continue
      let classification: Classification
      try {
        classification = classifierFor(app).classify(entry.file)
      } catch (error) {
        if (error instanceof ZoneConfigError) continue
        throw error
      }
      const name = display(ctx.root, entry.file)
      const denial = browserDenial(classification)
      if (denial !== undefined) {
        findings.push(
          diagnostic({
            code: "NF-C028",
            severity: "error",
            file: entry.config,
            line: entry.line,
            message: `clientModule ${JSON.stringify(entry.specifier)} puts ${name} in the browser bundle: ${denial}`,
            evidence: [`clientModule: ${entry.specifier}`, `zone: ${classification.zone}`],
            verify: "nifra check",
          }),
        )
      }
      if (classification.zone === "error" && classification.package === undefined)
        follow({ file: name, app, zone: "error" })
    }

    // An undeclared package is one fact, however many files import it.
    const reportedPackages = new Set<string>()
    // An array iterator reads the length on every step, so files `follow` appends are visited too.
    for (const { file, app, zone: from } of queue) {
      const content = ctx.sources.read(file)
      if (content === undefined) continue
      for (const { specifier, line } of importSites(content, file)) {
        const target = resolveSpecifier(join(ctx.root, file), specifier)
        if (target === undefined) continue
        const to = classifierFor(app).classify(target)
        const targetName = display(ctx.root, target)
        if (
          ["frontend", "route-frontend", "shared"].includes(from) &&
          (receipts.has(target) || receipts.has(targetName))
        )
          continue
        let message: string
        if (to.zone === "error") {
          if (to.package !== undefined) {
            if (reportedPackages.has(to.package)) continue
            reportedPackages.add(to.package)
          } else {
            // A file in no zone loads what it imports too: the build refuses each one it reaches.
            follow({ file: targetName, app, zone: "error" })
          }
          message = `${file} imports ${targetName}: ${to.reason}`
        } else if (
          from !== "error" &&
          ((SERVER.has(from) && FRONTEND.has(to.zone)) ||
            // Shared code reaching backend code is NF-C004's, reported there with the chain.
            (from === "shared" && !importAllowed(from, to.zone) && !BACKEND.has(to.zone)))
        ) {
          message = importRuleMessage(file, from, targetName, to.zone)
        } else continue
        findings.push(
          diagnostic({
            code: "NF-C028",
            severity: "error",
            file,
            line,
            message,
            evidence: [`import: ${specifier}`, `from zone: ${from}`, `to zone: ${to.zone}`],
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
