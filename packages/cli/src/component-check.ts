import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  isUnsupportedTypeScriptError,
  type UnsupportedTypeScriptError,
} from "./internal/typescript-import.ts"
import type { SourceIndex } from "./rules/index.ts"

type ComponentSource = typeof import("@nifrajs/web/server-components/source")

export interface ComponentCheck {
  readonly receipts: ReadonlySet<string>
  /** Set when the project's TypeScript has no compiler API to read component modules with
   * (TypeScript 7): no module gets a receipt, so the ordinary import rule judges each one. */
  readonly unsupported: UnsupportedTypeScriptError | undefined
}

const COMPONENT_SERVER = /\.component\.server\.[cm]?[jt]sx?$/

/** A source-only proof. nifra check never executes nifra.config.ts. */
export async function componentCheckReceipts(
  root: string,
  source: SourceIndex,
  load: () => Promise<ComponentSource> = () => import("@nifrajs/web/server-components/source"),
): Promise<ComponentCheck> {
  const receipts = new Set<string>()
  const result: ComponentCheck = { receipts, unsupported: undefined }
  if (!source.files.some((file) => COMPONENT_SERVER.test(file))) return result
  const configFile = ["nifra.config.ts", "backend/framework.ts"].find((file) =>
    existsSync(resolve(root, file)),
  )
  if (configFile === undefined) return result
  let components: ComponentSource
  try {
    components = await load()
  } catch (error) {
    if (isUnsupportedTypeScriptError(error)) return { receipts, unsupported: error }
    throw error
  }
  const pipeline = components.staticComponentPipeline(
    readFileSync(resolve(root, configFile), "utf8"),
    configFile,
  )
  if (typeof pipeline !== "object" || pipeline === null || Array.isArray(pipeline)) return result
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Static receipt inspection checks object shape before reading fields; the source scanner never executes configuration.
  const options = pipeline as Record<string, unknown>
  if (
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Static receipt inspection checks object shape before reading fields; the source scanner never executes configuration.
    !["react", "vue", "svelte", "solid", "preact"].includes(options.adapter as string) ||
    typeof options.entries !== "object" ||
    options.entries === null ||
    Array.isArray(options.entries)
  )
    return result
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Static receipt inspection checks object shape before reading fields; the source scanner never executes configuration.
  const entries = options.entries as Record<string, unknown>
  if (
    typeof entries.client !== "string" ||
    typeof entries.ssr !== "string" ||
    (options.adapter === "react" && typeof entries.rsc !== "string") ||
    Object.values(entries).some(
      (file) => typeof file !== "string" || !existsSync(resolve(root, file)),
    )
  )
    return result
  for (const file of source.files) {
    if (!COMPONENT_SERVER.test(file)) continue
    const content = source.read(file)
    if (content === undefined) continue
    try {
      components.compileComponentModule(content, resolve(root, file), root, "client")
      receipts.add(file)
      receipts.add(resolve(root, file))
    } catch {
      /* A module without a compilation receipt remains forbidden by the ordinary import rule. */
    }
  }
  return result
}
