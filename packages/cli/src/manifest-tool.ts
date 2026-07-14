/** `nifra manifest` — emit/sign/diff the deployable route trust artifact. */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { evaluateRouteAssurance } from "@nifrajs/core/assurance"
import {
  buildNifraManifest,
  diffNifraManifests,
  type NifraManifestDiff,
  parseNifraManifest,
  serializeNifraManifest,
  serializeNifraManifestSignature,
  signNifraManifest,
} from "@nifrajs/core/manifest"
import { loadAssuranceConfig } from "./assure.ts"
import { collectCapabilityProjectReport } from "./capabilities-tool.ts"

export const DEFAULT_MANIFEST_FILE = "nifra.manifest.json"

export function formatManifestDiff(diff: NifraManifestDiff): string {
  if (diff.changes.length === 0) return "No manifest changes."
  const weight = { breaking: 0, compatible: 1, info: 2 } as const
  const lines = [...diff.changes]
    .sort(
      (a, b) =>
        weight[a.severity] - weight[b.severity] ||
        a.path.localeCompare(b.path) ||
        a.method.localeCompare(b.method),
    )
    .map(
      (change) =>
        `${change.severity === "breaking" ? "✖" : change.severity === "compatible" ? "✓" : "•"} ${change.method} ${change.path} [${change.section}] ${change.message}`,
    )
  const breaking = diff.changes.filter((change) => change.severity === "breaking").length
  lines.push(
    diff.hasBreaking
      ? `${breaking} breaking manifest change${breaking === 1 ? "" : "s"}.`
      : "No breaking manifest changes.",
  )
  return lines.join("\n")
}

/** Build only after both assurance layers pass, then optionally create an operator-signed sidecar. */
export async function runManifestEmit(
  cwd: string,
  options: { readonly config?: string; readonly out?: string; readonly sign?: string } = {},
): Promise<boolean> {
  const config = await loadAssuranceConfig(cwd, options.config)
  const assurance = evaluateRouteAssurance(config.source, config.policy)
  const capabilityProject =
    config.capabilities === undefined
      ? undefined
      : await collectCapabilityProjectReport(cwd, config.source, config.capabilities)
  if (!assurance.ok || (capabilityProject !== undefined && !capabilityProject.report.ok)) {
    console.error("[nifra] refusing to emit a manifest from failing assurance")
    return false
  }
  const manifest = await buildNifraManifest({
    source: config.source,
    assurance,
    ...(capabilityProject !== undefined ? { capabilities: capabilityProject.report } : {}),
  })
  const path = resolve(cwd, options.out ?? config.manifest?.path ?? DEFAULT_MANIFEST_FILE)
  await Bun.write(path, `${serializeNifraManifest(manifest)}\n`)

  if (options.sign !== undefined) {
    if (config.manifest?.signer === undefined) {
      throw new Error(
        "[nifra] --sign requires manifest.signer in nifra.assurance.ts; keep private keys behind that KMS/HSM callback.",
      )
    }
    const signer = await config.manifest.signer(options.sign)
    const signature = await signNifraManifest(manifest, signer)
    await Bun.write(`${path}.sig`, `${serializeNifraManifestSignature(signature)}\n`)
  }
  console.log(
    `[nifra] wrote manifest to ${path}${options.sign === undefined ? "" : ` and ${path}.sig`}`,
  )
  return true
}

/** Diff two already-emitted, hash-verified artifacts. Suitable for deploy promotion gates. */
export async function runManifestDiff(
  cwd: string,
  beforePath: string,
  afterPath: string,
  options: { readonly json?: boolean } = {},
): Promise<boolean> {
  const before = resolve(cwd, beforePath)
  const after = resolve(cwd, afterPath)
  if (!existsSync(before)) throw new Error(`[nifra] manifest not found: ${before}`)
  if (!existsSync(after)) throw new Error(`[nifra] manifest not found: ${after}`)
  const diff = diffNifraManifests(
    await parseNifraManifest(await Bun.file(before).text(), before),
    await parseNifraManifest(await Bun.file(after).text(), after),
  )
  console.log(
    options.json === true
      ? JSON.stringify({ hasBreaking: diff.hasBreaking, changes: diff.changes }, null, 2)
      : formatManifestDiff(diff),
  )
  return !diff.hasBreaking
}
