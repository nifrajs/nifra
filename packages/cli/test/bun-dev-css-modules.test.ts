import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

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
    const root = mkdtempSync(join(import.meta.dir, ".tmp-nifra-devcss-"))
    let proc: ReturnType<typeof Bun.spawn> | undefined
    try {
      mkdirSync(join(root, "routes"), { recursive: true })
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
      expect(banner).toContain("nifra dev (bun)")
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
      rmSync(root, { recursive: true, force: true })
    }
  },
  { timeout: 90_000 },
)
