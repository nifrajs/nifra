import { expect, test } from "bun:test"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createFixtureRoot, removeFixtureRoot } from "./fixture-root.ts"

/**
 * `nifra dev`'s Bun pipeline has TWO module loaders: Bun's dev-server bundler builds the client
 * (configured by the generated bunfig), and Bun's runtime resolves SSR in the CLI process. A CSS
 * Module has to mean the same thing in both, because the class name is in the SSR markup and the
 * matching selector is in the client's stylesheet.
 *
 * Transforming only the client half is the failure this pins: `styles.card` is `undefined` on the
 * server, the page ships `<div>` with no class, paints unstyled, and hydration reports a className
 * mismatch. The client bundle looks perfect the whole time - which is why the assertion has to
 * compare the SERVED HTML against the SERVED stylesheet rather than test either alone.
 */
test(
  "nifra dev (bun): the SSR class name matches the client stylesheet's selector",
  async () => {
    const root = createFixtureRoot("tmp-nifra-devcss-")
    let proc: ReturnType<typeof Bun.spawn> | undefined
    try {
      mkdirSync(join(root, "routes"), { recursive: true })
      // The fixture app declares its own `@nifrajs/*`, rather than letting the specifier walk up into
      // the monorepo's root `node_modules`. A root-level `@nifrajs/` link farm is not something an
      // install guarantees: `bun install --frozen-lockfile` links a workspace package into the
      // `node_modules` of the packages that DEPEND on it, and a root entry only appears where a tree
      // has accumulated one. So the walk-up finds the adapter on a developer machine with a lived-in
      // checkout, and finds nothing on a fresh clone - the app dies before it can print its banner,
      // and only on the machine nobody is watching.
      const nodeModules = join(root, "node_modules", "@nifrajs")
      mkdirSync(nodeModules, { recursive: true })
      for (const pkg of ["web", "web-react"]) {
        symlinkSync(resolve(import.meta.dir, "..", "..", pkg), join(nodeModules, pkg), "dir")
      }
      writeFileSync(join(root, "styles.module.css"), ".card { color: rebeccapurple }\n")
      writeFileSync(
        join(root, "nifra.config.ts"),
        [
          'import { reactAdapter } from "@nifrajs/web-react"',
          "export const adapter = reactAdapter",
          'export const clientModule = "@nifrajs/web-react/client"',
        ].join("\n"),
      )
      writeFileSync(
        join(root, "routes", "index.tsx"),
        [
          'import styles from "../styles.module.css"',
          "export default function Home() {",
          "  return <div className={styles.card}>hello</div>",
          "}",
        ].join("\n"),
      )

      const cli = resolve(import.meta.dir, "../src/cli.ts")
      // Port 0: the banner reports the port Bun actually bound, so nothing here can collide.
      proc = Bun.spawn(["bun", cli, "dev", "--port", "0"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      })
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
      let banner = ""
      const deadline = Date.now() + 60_000
      while (!/http:\/\/localhost:\d+/.test(banner) && Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        banner += new TextDecoder().decode(value)
      }
      // A dev server that dies before printing anything asserts on an empty string, and the reason it
      // died is on the stderr nobody read - "Expected to contain … Received: ''" and no other evidence.
      // Fold stderr into the failure instead: this spawns a whole toolchain, and the interesting
      // failures are the ones that happen on a machine that is not this one.
      if (!banner.includes("nifra dev (bun)")) {
        const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text()
        throw new Error(
          `nifra dev printed no banner (exit ${await proc.exited}).\n--- stdout ---\n${banner}\n--- stderr ---\n${stderr}`,
        )
      }
      const port = Number(/http:\/\/localhost:(\d+)/.exec(banner)?.[1])
      expect(Number.isInteger(port)).toBe(true)

      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text()
      // The scoped name the SSR render emitted - `card_<hash>`, never a bare `card` and never absent.
      const ssrClass = /class="(card_[a-z0-9]+)"/.exec(html)?.[1]
      expect(ssrClass).toBeDefined()

      const stylesheet = /<link[^>]+rel="stylesheet"[^>]+href="([^"]+\.css)"/.exec(html)?.[1]
      expect(stylesheet).toBeDefined()
      const css = await (await fetch(`http://127.0.0.1:${port}${stylesheet}`)).text()
      // The whole point: the client's selector is the name the server rendered.
      expect(css).toContain(`.${ssrClass}`)
      expect(css).toMatch(/(?:rebeccapurple|#639)/)
    } finally {
      proc?.kill()
      removeFixtureRoot(root)
    }
  },
  { timeout: 90_000 },
)
