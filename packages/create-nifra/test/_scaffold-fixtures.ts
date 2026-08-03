/**
 * Materialize every scaffold a user can ask for, so tests grade the artifact rather than its sources.
 *
 * These assertions used to read `template-site-<framework>/` directly, which was only ever a proxy for
 * what someone receives - fine while a scaffold WAS a directory copy. A site is composed now, so
 * reading the sources would check thirteen shared files five times and never look at the eight the
 * model emits. Composing first is what keeps "a fresh scaffold passes its own check" an honest claim.
 */
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FRAMEWORK_IDS } from "../src/scaffold/frameworks.ts"
import { materializeSite } from "../src/scaffold/site.ts"

const PKG_ROOT = join(import.meta.dir, "..")

/** Templates that are still a plain directory copy - they have no framework axis to collapse. */
export const COPIED_TEMPLATES = ["template", "template-isr", "template-batteries"] as const

export interface Scaffold {
  /** How the test names it, e.g. `site-vue` or `template-isr`. */
  readonly label: string
  readonly dir: string
}

/**
 * Build every scaffold into a fresh temp root. Call `cleanup` in `afterAll`.
 *
 * One root per caller rather than a module-level singleton: bun runs a directory's test files in one
 * process, and a shared temp tree that one file removed while another was reading it would fail in a
 * way that looks like a scaffold bug.
 */
export async function materializeAll(): Promise<{
  readonly scaffolds: readonly Scaffold[]
  readonly cleanup: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), "nifra-scaffolds-"))
  const scaffolds: Scaffold[] = []

  for (const id of FRAMEWORK_IDS) {
    const dir = join(root, `site-${id}`)
    await materializeSite(dir, id)
    scaffolds.push({ label: `site-${id}`, dir })
  }
  for (const template of COPIED_TEMPLATES) {
    const dir = join(root, template)
    await cp(join(PKG_ROOT, template), dir, { recursive: true })
    scaffolds.push({ label: template, dir })
  }

  return { scaffolds, cleanup: () => rm(root, { recursive: true, force: true }) }
}
