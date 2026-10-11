import { expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { buildServerComponents } from "../src/server-components/build.ts"

test("React builds guarded native JSX runtimes and default client exports", async () => {
  const source = resolve(import.meta.dirname, "../../web-react/test/fixtures/server-components")
  const root = await mkdtemp(resolve(source, "..", ".compiler-react-"))
  try {
    await cp(source, root, {
      recursive: true,
      filter: (file) => !file.includes("/node_modules/") && !file.includes("/.vite/"),
    })
    const clientFile = resolve(root, "frontend/Client.tsx")
    await writeFile(
      clientFile,
      (await readFile(clientFile, "utf8")).replace(
        "export function Counter",
        "export default function Counter",
      ),
    )
    const propsFile = resolve(root, "frontend/Client.props.ts")
    await writeFile(
      propsFile,
      `${(await readFile(propsFile, "utf8"))
        .replace("export const Counter =", "const Counter =")
        .replace("CounterSlots", "defaultSlots")}\nexport default Counter\n`,
    )
    const childFile = resolve(root, "Child.component.server.tsx")
    await writeFile(
      childFile,
      (await readFile(childFile, "utf8")).replace(
        'import { Counter } from "./frontend/Client"',
        'import Counter from "./frontend/Client"',
      ),
    )
    const summaryFile = resolve(root, "Summary.component.server.tsx")
    await writeFile(
      summaryFile,
      `import { jsx } from "react/jsx-runtime"\nimport { jsxDEV } from "react/jsx-dev-runtime"\n${(
        await readFile(summaryFile, "utf8")
      )
        .replace(
          'import { Counter as Native } from "./frontend/Client"',
          'import Native from "./frontend/Client"',
        )
        .replace(
          'return el("p", {}, "Public detail")',
          'return jsx("p", { children: jsxDEV("span", { children: "Public detail" }, undefined, false, undefined, undefined) })',
        )}`,
    )
    const result = await buildServerComponents({
      root,
      adapter: "react",
      target: "node",
      outDir: "dist",
      entries: {
        client: "entry.client.ts",
        ssr: "entry-ssr.backend.ts",
        rsc: "entry-rsc.backend.tsx",
      },
    })
    expect(result.build).toMatch(/^c_[a-f0-9]{64}$/)
    expect(await readFile(resolve(result.outDir, "component-manifest.json"), "utf8")).toContain(
      "assets/",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

test("React native facade refuses missing schemas and dynamic or reserved managed slots", async () => {
  const source = resolve(import.meta.dirname, "../../web-react/test/fixtures/server-components")
  for (const mode of ["missing", "dynamic-slots", "reserved-slots", "unregistered"] as const) {
    const root = await mkdtemp(resolve(source, "..", ".compiler-react-"))
    try {
      await cp(source, root, {
        recursive: true,
        filter: (file) => !file.includes("/node_modules/") && !file.includes("/.vite/"),
      })
      const file = resolve(root, "frontend/Client.props.ts")
      const original = await readFile(file, "utf8")
      if (mode === "missing") await rm(file)
      else if (mode === "dynamic-slots")
        await writeFile(file, original.replace('["summary"] as const', '(() => ["summary"])()'))
      else if (mode === "reserved-slots")
        await writeFile(file, original.replace('["summary"]', '["constructor"]'))
      else
        await writeFile(
          file,
          'import { t } from "@nifrajs/schema"; export const Other = t.object({ title: t.string() })',
        )
      const message =
        mode === "missing"
          ? "requires"
          : mode === "dynamic-slots"
            ? "literal array"
            : mode === "reserved-slots"
              ? "Invalid managed slot"
              : "no registered props schema"
      await expect(
        buildServerComponents({
          root,
          adapter: "react",
          target: "node",
          outDir: "dist",
          entries: {
            client: "entry.client.ts",
            ssr: "entry-ssr.backend.ts",
            rsc: "entry-rsc.backend.tsx",
          },
        }),
      ).rejects.toThrow(message)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}, 60000)

test("component compiler rejects raw source assets and native closure-action modules", async () => {
  const base = resolve(import.meta.dirname, "../../../.nifra-components-fixtures")
  await mkdir(base, { recursive: true })
  for (const mode of ["raw-source", "native-action"] as const) {
    const root = await mkdtemp(resolve(base, "compiler-proof-"))
    try {
      await writeFile(
        resolve(root, "entry.backend.ts"),
        'export function createApp() { return { fetch: () => new Response("Public") } }',
      )
      if (mode === "raw-source") {
        await writeFile(
          resolve(root, "Summary.component.server.ts"),
          'export const privateValue = "fabricated-private"',
        )
        await writeFile(
          resolve(root, "entry.frontend.ts"),
          'import source from "./Summary.component.server.ts?raw"; document.body.textContent = source',
        )
      } else
        await writeFile(
          resolve(root, "entry.frontend.ts"),
          '"use server"; export async function unsafeAction() { return "private" }',
        )
      await expect(
        buildServerComponents({
          root,
          adapter: "vue",
          target: "node",
          entries: { client: "entry.frontend.ts", ssr: "entry.backend.ts" },
        }),
      ).rejects.toThrow(mode === "raw-source" ? "may not reach the browser" : "use-server actions")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}, 30000)
