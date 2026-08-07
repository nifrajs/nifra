/**
 * Regression gate: a Deno user must be able to `import` the PUBLISHED `@nifrajs/deno` tarball.
 *
 *   bun run scripts/check-deno-tarball.ts
 *
 * Why this exists. Through 2.9.0 the package shipped `files: ["src"]` with every export condition
 * pointing at `./src/index.ts`. Deno refuses to strip TypeScript types for any file under
 * `node_modules` - including its own npm cache - so every install failed at import:
 *
 *   error: [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported
 *   for files under node_modules, for ".../@nifrajs/deno/2.9.0/src/index.ts"
 *
 * Nothing in the repo caught it. `test:deno`, the benchmarks, and the examples all import
 * `packages/deno/src/index.ts` by workspace-relative path - which is NOT under `node_modules`, so
 * stripping is allowed there and the broken shape never surfaces. The only way to see it is to pack
 * the tarball, install it into `node_modules`, and let Deno resolve it, which is what this does.
 *
 * Two layers, cheapest first:
 *  1. Static: no `exports` condition in the packed manifest may resolve to a `.ts` file, and every
 *     target must exist in the tarball. Runs without Deno installed.
 *  2. Live: install the tarball outside the repo, then `deno check` + `deno run` a consumer that
 *     imports the BARE specifier, serves a request through it, and shuts down. Skipped with a
 *     non-zero exit only if Deno is absent when `--require-deno` is passed (CI does).
 *
 * The temp tree is deliberately outside the repo: a `bun install` inside it would let the root
 * workspace claim the directory and link `@nifrajs/deno` straight back to `packages/deno`, which
 * would pass while testing nothing.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"

const PKG_DIR = "packages/deno"
const requireDeno = process.argv.includes("--require-deno")

let failures = 0
const fail = (message: string): void => {
  failures += 1
  console.error(`✗ ${message}`)
}

const workdir = await mkdtemp(join(tmpdir(), "nifra-deno-tarball-"))
const consumer = join(workdir, "consumer")
await $`mkdir -p ${consumer}`.quiet()

try {
  // ── Wiring guard. This script builds the package itself, so it would stay green even if the
  // release pipeline stopped building it - and `changeset:publish` runs only the ROOT `build`.
  // Assert the package is still in that fan-out, or a release could ship an empty `dist/`.
  const rootBuild = (
    JSON.parse(await Bun.file("package.json").text()) as { scripts: Record<string, string> }
  ).scripts.build
  if (rootBuild === undefined || !rootBuild.includes("@nifrajs/deno")) {
    fail("the root `build` script no longer builds @nifrajs/deno - a release would ship no dist")
  } else {
    console.log("✓ the root build script builds @nifrajs/deno")
  }

  // ── Build + pack exactly as `bun publish` would.
  const built = await $`bun run --filter '@nifrajs/deno' build`.nothrow().quiet()
  if (built.exitCode !== 0) {
    console.error(built.stderr.toString())
    fail("`bun run --filter '@nifrajs/deno' build` failed")
    process.exit(1)
  }
  const packed = await $`bun pm pack --destination ${workdir}`.cwd(PKG_DIR).nothrow().quiet()
  const tgz = (await $`ls ${workdir}`.text())
    .trim()
    .split("\n")
    .find((entry) => entry.endsWith(".tgz"))
  if (packed.exitCode !== 0 || tgz === undefined) {
    console.error(packed.stderr.toString())
    fail(`bun pm pack failed in ${PKG_DIR} (exit ${packed.exitCode})`)
    process.exit(1)
  }
  const tarball = join(workdir, tgz)

  // ── Layer 1: static shape of the packed manifest.
  const manifest = JSON.parse(await $`tar -xzOf ${tarball} package/package.json`.text()) as {
    name: string
    version: string
    types?: string
    exports?: Record<string, Record<string, string> | string>
  }
  const entries = new Set(
    (await $`tar -tzf ${tarball}`.text())
      .trim()
      .split("\n")
      .map((entry) => entry.replace(/^package\//, "")),
  )
  const targets = new Map<string, string>()
  for (const [subpath, entry] of Object.entries(manifest.exports ?? {})) {
    if (typeof entry === "string") targets.set(subpath, entry)
    else {
      for (const [condition, target] of Object.entries(entry)) {
        if (typeof target === "string") targets.set(`${subpath} (${condition})`, target)
      }
    }
  }
  if (manifest.types !== undefined) targets.set('"types"', manifest.types)
  const failuresBeforeTargets = failures
  for (const [label, target] of targets) {
    const path = target.replace(/^\.\//, "")
    if (path.endsWith(".ts") && !path.endsWith(".d.ts")) {
      fail(`${manifest.name} ${label} → ${target}: Deno cannot strip types under node_modules`)
    } else if (!entries.has(path)) {
      fail(`${manifest.name} ${label} → ${target}: not present in the tarball`)
    }
  }
  if (failures === failuresBeforeTargets) {
    console.log(`✓ ${manifest.name}@${manifest.version}: every export target ships as loadable JS`)
  }

  // ── Layer 2: a real Deno consumer resolving the installed package from node_modules.
  const denoVersion = await $`deno --version`.nothrow().quiet()
  if (denoVersion.exitCode !== 0) {
    const message = "deno not installed - skipped the live install+import check"
    if (requireDeno) fail(message)
    else console.log(`- ${message}`)
  } else {
    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify(
        {
          name: "nifra-deno-tarball-consumer",
          private: true,
          type: "module",
          dependencies: { "@nifrajs/deno": `file:${tarball}` },
        },
        null,
        2,
      )}\n`,
    )
    // `nodeModulesDir: manual` makes Deno resolve the bare specifier out of the node_modules tree
    // we install below - the same code path an installed user hits, and the one that rejects TS.
    await writeFile(
      join(consumer, "deno.json"),
      `${JSON.stringify({ nodeModulesDir: "manual" })}\n`,
    )
    await writeFile(
      join(consumer, "main.ts"),
      `import { serve } from "@nifrajs/deno"\n\n` +
        `const running = await serve({ fetch: () => new Response("ok") }, { port: 0 })\n` +
        `const response = await fetch(\`http://127.0.0.1:\${running.port}/\`)\n` +
        `const body = await response.text()\n` +
        `await running.stop()\n` +
        `if (body !== "ok") throw new Error(\`expected "ok", got \${JSON.stringify(body)}\`)\n` +
        `console.log("NIFRA_DENO_TARBALL_OK")\n`,
    )

    const install = await $`bun install --no-save`.cwd(consumer).nothrow().quiet()
    if (install.exitCode !== 0) {
      console.error(install.stderr.toString())
      fail(`installing the tarball into a consumer failed (exit ${install.exitCode})`)
    } else {
      // Type resolution first: this is what proves the shipped `.d.ts` (not the source) is what a
      // Deno user typechecks against.
      const checked = await $`deno check main.ts`.cwd(consumer).nothrow().quiet()
      if (checked.exitCode !== 0) {
        console.error(checked.stderr.toString())
        fail("`deno check` failed against the installed package's shipped types")
      } else {
        console.log("✓ deno check resolves the installed package's types")
      }

      const ran = await $`deno run --allow-net --allow-read --allow-env main.ts`
        .cwd(consumer)
        .nothrow()
        .quiet()
      const stdout = ran.stdout.toString()
      if (ran.exitCode !== 0 || !stdout.includes("NIFRA_DENO_TARBALL_OK")) {
        console.error(ran.stderr.toString() || stdout)
        fail(`the installed package failed to import and serve under Deno (exit ${ran.exitCode})`)
      } else {
        console.log("✓ deno run imported the installed package and served a request through it")
      }
    }
  }
} finally {
  await rm(workdir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed - @nifrajs/deno is not installable by a Deno user`)
  process.exit(1)
}
console.log("\n✓ @nifrajs/deno installs and imports from a packed tarball under Deno")
