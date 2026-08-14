/** `nifra manifest` - emit/sign/diff the deployable route trust artifact. */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import {
  buildNifraManifest,
  diffNifraManifests,
  type NifraManifest,
  type NifraManifestDiff,
  parseNifraManifest,
  serializeNifraManifest,
  serializeNifraManifestSignature,
  signNifraManifest,
} from "@nifrajs/core/manifest"
import { collectProjectVerification } from "./verification.ts"

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

export interface ManifestEmitCommandResult {
  readonly ok: boolean
  readonly path: string
  readonly manifest?: NifraManifest
  readonly signaturePath?: string
}

/** Emit the manifest without printing. This is the execution seam used by all adapters. */
export async function collectManifestEmit(
  cwd: string,
  options: { readonly config?: string; readonly out?: string; readonly sign?: string } = {},
): Promise<ManifestEmitCommandResult> {
  const verification = await collectProjectVerification(cwd, {
    ...(options.config !== undefined ? { config: options.config } : {}),
  })
  if (verification.config === undefined) {
    throw (
      verification.configError ??
      new Error("[nifra] assurance config could not be loaded for manifest emission")
    )
  }
  const config = verification.config
  const assurance = verification.routeAssurance
  const capabilityProject = verification.capability
  if (assurance === undefined) {
    throw new Error("[nifra] assurance evaluation was unavailable for manifest emission")
  }
  const path = resolve(cwd, options.out ?? config.manifest?.path ?? DEFAULT_MANIFEST_FILE)
  if (!assurance.ok || (capabilityProject !== undefined && !capabilityProject.report.ok)) {
    return { ok: false, path }
  }
  const manifest = await buildNifraManifest({
    source: config.source,
    ...(verification.evidence !== undefined ? { evidence: verification.evidence } : {}),
    assurance,
    ...(capabilityProject !== undefined ? { capabilities: capabilityProject.report } : {}),
  })
  await Bun.write(path, `${serializeNifraManifest(manifest)}\n`)

  let signaturePath: string | undefined
  if (options.sign !== undefined) {
    if (config.manifest?.signer === undefined) {
      throw new Error(
        "[nifra] --sign requires manifest.signer in nifra.assurance.ts; keep private keys behind that KMS/HSM callback.",
      )
    }
    const signer = await config.manifest.signer(options.sign)
    const signature = await signNifraManifest(manifest, signer)
    signaturePath = `${path}.sig`
    await Bun.write(signaturePath, `${serializeNifraManifestSignature(signature)}\n`)
  }
  return { ok: true, path, manifest, ...(signaturePath === undefined ? {} : { signaturePath }) }
}

/** Build only after both assurance layers pass, then optionally create an operator-signed sidecar. */
export async function runManifestEmit(
  cwd: string,
  options: { readonly config?: string; readonly out?: string; readonly sign?: string } = {},
): Promise<boolean> {
  const result = await collectManifestEmit(cwd, options)
  if (!result.ok) {
    console.error("[nifra] refusing to emit a manifest from failing assurance")
    return false
  }
  console.log(
    `[nifra] wrote manifest to ${result.path}${result.signaturePath === undefined ? "" : ` and ${result.signaturePath}`}`,
  )
  return true
}

/** Diff two already-emitted, hash-verified artifacts. Suitable for deploy promotion gates. */
export async function collectManifestDiff(
  cwd: string,
  beforePath: string,
  afterPath: string,
): Promise<NifraManifestDiff> {
  const before = resolve(cwd, beforePath)
  const after = resolve(cwd, afterPath)
  if (!existsSync(before)) throw new Error(`[nifra] manifest not found: ${before}`)
  if (!existsSync(after)) throw new Error(`[nifra] manifest not found: ${after}`)
  return diffNifraManifests(
    await parseNifraManifest(await Bun.file(before).text(), before),
    await parseNifraManifest(await Bun.file(after).text(), after),
  )
}

/** Diff two already-emitted, hash-verified artifacts and print the result. */
export async function runManifestDiff(
  cwd: string,
  beforePath: string,
  afterPath: string,
  options: { readonly json?: boolean } = {},
): Promise<boolean> {
  const diff = await collectManifestDiff(cwd, beforePath, afterPath)
  console.log(
    options.json === true
      ? JSON.stringify({ hasBreaking: diff.hasBreaking, changes: diff.changes }, null, 2)
      : formatManifestDiff(diff),
  )
  return !diff.hasBreaking
}
