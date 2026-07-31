import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { FRAMEWORK_SPECS } from "../src/scaffold/frameworks.ts"
import { BUILD_TARGETS, renderBuildFile } from "../src/scaffold/site-build.ts"

/**
 * The generator has to reproduce what was checked in.
 *
 * Five site templates were five directories of the same 26 files, and collapsing them into a model is
 * only safe if the result is the same scaffold - otherwise "we generate the templates now" quietly
 * means "the templates changed and nobody read the diff". So this compares generated text against the
 * committed files while both still exist. Once it passes, the redundant directories can go, and this
 * test is what says they may.
 *
 * Executable content must match EXACTLY - that is the property that says no scaffold's build changed.
 * Comments are allowed to differ in one direction only, and only where listed below, because five
 * hand-maintained copies had drifted: a comment written into one target's copy never reached the other
 * four. Generating them is what fixes that, so the fix shows up here as text the generator ADDS. Every
 * such line is named, so it is reviewed rather than absorbed.
 */

const ROOT = join(import.meta.dir, "..")
const templateDir = (framework: string): string =>
  framework === "react" ? join(ROOT, "template-site") : join(ROOT, `template-site-${framework}`)

/** Comment lines the generator restores to copies that had lost them. */
const RESTORED_COMMENTS: Readonly<Record<string, readonly string[]>> = {
  // react's Vercel entry explains the Build Output API layout it emits; the three copies made later
  // kept a two-line header and dropped the note over `config.json`. Same target, same output.
  "solid/build-vercel.ts": [
    "// framework preset: `vercel deploy --prebuilt`. Layout:",
    "//   .vercel/output/config.json                   — serve static files, else SSR via the function",
    "//   .vercel/output/static/assets/<client bundle>  — Vercel's CDN serves these directly",
    "//   .vercel/output/functions/index.func/index.js  — the Edge SSR function (+ .vc-config.json)",
    "// Build Output API v3: serve real files first (`handle: filesystem` → /assets/*), then SSR the rest.",
  ],
  "svelte/build-vercel.ts": [
    "// framework preset: `vercel deploy --prebuilt`. Layout:",
    "//   .vercel/output/config.json                   — serve static files, else SSR via the function",
    "//   .vercel/output/static/assets/<client bundle>  — Vercel's CDN serves these directly",
    "//   .vercel/output/functions/index.func/index.js  — the Edge SSR function (+ .vc-config.json)",
    "// Build Output API v3: serve real files first (`handle: filesystem` → /assets/*), then SSR the rest.",
  ],
  "vue/build-vercel.ts": [
    "// Build Output API v3: serve real files first (`handle: filesystem` → /assets/*), then SSR the rest.",
  ],
  // Vue's feature-flag defines are explained in its Cloudflare entry only. The other four targets set
  // the same flags with no word about why.
  "vue/build-bun.ts": [
    '// Vue feature flags: silence "feature flag not explicitly defined" warnings + trim dev-only code.',
  ],
  "vue/build-node.ts": [
    '// Vue feature flags: silence "feature flag not explicitly defined" warnings + trim dev-only code.',
  ],
  "vue/build-deno.ts": [
    '// Vue feature flags: silence "feature flag not explicitly defined" warnings + trim dev-only code.',
  ],
  "vue/build-vercel.ts:defines": [
    '// Vue feature flags: silence "feature flag not explicitly defined" warnings + trim dev-only code.',
  ],
}

const codeOf = (source: string): string =>
  source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n")

describe("the generator reproduces the checked-in site templates", () => {
  for (const [id, spec] of Object.entries(FRAMEWORK_SPECS)) {
    for (const target of BUILD_TARGETS) {
      const key = `${id}/${target.file}`

      test(`${key} - executable content is identical`, async () => {
        const committed = await readFile(join(templateDir(id), target.file), "utf8")
        expect(codeOf(renderBuildFile(target, spec))).toBe(codeOf(committed))
      })

      test(`${key} - comments differ only by restored lines`, async () => {
        const committed = await readFile(join(templateDir(id), target.file), "utf8")
        const generated = renderBuildFile(target, spec)
        if (generated === committed) return

        const committedLines = new Set(committed.split("\n"))
        const added = generated
          .split("\n")
          .filter((line) => line.trimStart().startsWith("//") && !committedLines.has(line))
        // Nothing may be LOST. A comment may be EXTENDED - one copy ended the sentence at
        // "`vercel deploy --prebuilt`." where the fuller one continues "… Layout:" and lists it - so a
        // committed line counts as surviving when a generated line begins with it. Anything else
        // missing is a comment generation dropped, which is not a trade this refactor may make.
        const generatedComments = generated
          .split("\n")
          .filter((line) => line.trimStart().startsWith("//"))
        const removed = committed
          .split("\n")
          .filter(
            (line) =>
              line.trimStart().startsWith("//") &&
              !generatedComments.some((candidate) => candidate.startsWith(line)),
          )
        expect(removed).toEqual([])

        const allowed = new Set(
          Object.entries(RESTORED_COMMENTS)
            .filter(([entry]) => entry.split(":")[0] === key)
            .flatMap(([, lines]) => lines),
        )
        expect(added.filter((line) => !allowed.has(line))).toEqual([])
      })
    }
  }
})
