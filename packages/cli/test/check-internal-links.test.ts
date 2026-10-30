import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { collectCheckResult } from "../src/check.ts"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

let root: string

beforeEach(() => {
  root = createFixtureRoot("tmp-check-internal-links-")
})
afterEach(() => removeFixtureRoot(root))

const PAGE = "export default function Page() { return null }\n"

function pages(): void {
  writeAppFile(root, "routes/index.tsx", PAGE)
  writeAppFile(root, "routes/pricing.tsx", PAGE)
  writeAppFile(root, "routes/users/[id].tsx", PAGE)
  mkdirSync(join(root, "public"), { recursive: true })
  writeFileSync(join(root, "public/robots.txt"), "User-agent: *\n")
  writeAppFile(
    root,
    "backend/routes.ts",
    `import { server } from "@nifrajs/core/server"
export const app = server().get("/api/health", () => ({ ok: true }))
`,
  )
}

const findings = async (...codes: string[]): Promise<readonly string[]> => {
  const result = await collectCheckResult(root, { lintsOnly: true })
  return result.diagnostics
    .filter((diagnostic) => codes.some((code) => code === diagnostic.code))
    .map(
      (diagnostic) =>
        `${diagnostic.code} ${diagnostic.file}:${diagnostic.line} ${diagnostic.severity}`,
    )
}

test("a path string that names a page is info, one that names nothing is a warning", async () => {
  pages()
  writeAppFile(
    root,
    "routes/_layout.tsx",
    `export default function Layout(props: { children?: unknown; id: string }) {
  const { id } = props
  return (
    <nav>
      <a href="/pricing">pricing</a>
      <a href="/pricng">typo</a>
      <a href="/users/7">user</a>
      <a href={\`/users/\${id}\`}>user</a>
      <a href={\`/nope/\${id}\`}>dynamic and unknown</a>
      <a href="/pricing#faq">faq</a>
      <a href="/pricing?plan=pro">plan</a>
      <a href="/gone">gone</a>
    </nav>
  )
}
`,
  )
  expect(await findings("NF-C057", "NF-C058")).toEqual([
    "NF-C057 routes/_layout.tsx:6 warning",
    "NF-C057 routes/_layout.tsx:12 warning",
    "NF-C058 routes/_layout.tsx:5 info",
    "NF-C058 routes/_layout.tsx:7 info",
    "NF-C058 routes/_layout.tsx:8 info",
    "NF-C058 routes/_layout.tsx:10 info",
    "NF-C058 routes/_layout.tsx:11 info",
  ])
})

test("external links, built links, files, backend routes and framework paths are left alone", async () => {
  pages()
  writeAppFile(
    root,
    "routes/_layout.tsx",
    `import { href, rawHref } from "@nifrajs/web-react/router"
export default function Layout(props: { url: string }) {
  return (
    <nav>
      <a href="https://example.com/pricing">site</a>
      <a href="mailto:a@b.c">mail</a>
      <a href="tel:+1">tel</a>
      <a href="#top">top</a>
      <a href="//cdn.example.com/x">cdn</a>
      <a href={href({ to: "/pricing" })}>built</a>
      <a href={rawHref("/elsewhere")}>raw</a>
      <a href={props.url}>variable</a>
      <a href="/robots.txt">file in public</a>
      <a href="/feed.xml">file extension</a>
      <a href="/api/health">backend route</a>
      <a href="/_nifra/live">framework path</a>
    </nav>
  )
}
`,
  )
  expect(await findings("NF-C057", "NF-C058")).toEqual([])
})

test("a link kept on purpose takes nifra-expect, and the reason is shown to the next reader", async () => {
  pages()
  writeAppFile(
    root,
    "routes/_layout.tsx",
    `export default function Layout() {
  return (
    <nav>
      <a
        // nifra-expect NF-C058: the marketing site links here too
        href="/pricing"
      >
        pricing
      </a>
      <a
        // nifra-expect NF-C057: served by the CDN in front of the app
        href="/partners"
      >
        partners
      </a>
    </nav>
  )
}
`,
  )
  expect(await findings("NF-C057", "NF-C058")).toEqual([])
})

test("Vue and Svelte templates are read: a static, a bound and an interpolated href", async () => {
  pages()
  writeAppFile(
    root,
    "routes/about.vue",
    `<template>
  <nav>
    <a href="/pricing">pricing</a>
    <a :href="'/pricng'">typo</a>
    <a :href="url">built</a>
    <a href="https://example.com/">out</a>
  </nav>
</template>
`,
  )
  writeAppFile(
    root,
    "routes/contact.svelte",
    `<nav>
  <a href="/users/{id}">user</a>
  <a href={"/gone"}>gone</a>
  <a href={href({ to: "/pricing" })}>built</a>
</nav>
`,
  )
  expect(await findings("NF-C057", "NF-C058")).toEqual([
    "NF-C057 routes/about.vue:4 warning",
    "NF-C057 routes/contact.svelte:3 warning",
    "NF-C058 routes/about.vue:3 info",
    "NF-C058 routes/contact.svelte:2 info",
  ])
})

test("an app with no page routes, or with a backend route path the scan cannot read, never gets a dead-link verdict", async () => {
  writeAppFile(
    root,
    "components/nav.tsx",
    `export const Nav = () => <a href="/anything">x</a>
`,
  )
  expect(await findings("NF-C057", "NF-C058")).toEqual([])
  pages()
  writeAppFile(
    root,
    "backend/more.ts",
    `import { server } from "@nifrajs/core/server"
const PATH = "/" + "dyn"
export const more = server().get(PATH, () => ({ ok: true }))
`,
  )
  writeAppFile(
    root,
    "components/links.tsx",
    `export const Links = () => (
  <>
    <a href="/pricing">pricing</a>
    <a href="/gone">gone</a>
  </>
)
`,
  )
  expect(await findings("NF-C057", "NF-C058")).toEqual(["NF-C058 components/links.tsx:3 info"])
})

test("the message names the nearest page and the href() call that replaces the string", async () => {
  pages()
  writeAppFile(
    root,
    "routes/_layout.tsx",
    `export default function Layout() {
  return (
    <nav>
      <a href="/pricng">typo</a>
      <a href="/users/7#bio">user</a>
    </nav>
  )
}
`,
  )
  const result = await collectCheckResult(root, { lintsOnly: true })
  const messages = result.diagnostics
    .filter((diagnostic) => diagnostic.code === "NF-C057" || diagnostic.code === "NF-C058")
    .map((diagnostic) => diagnostic.message)
  expect(messages.some((message) => message.includes("Did you mean /pricing?"))).toBe(true)
  expect(
    messages.some((message) =>
      message.includes('href({ to: "/users/:id", params: { id: "7" }, hash: "bio" })'),
    ),
  ).toBe(true)
})

test("a page written as .mdx, .vue or .svelte is a page: its links are not dead", async () => {
  pages()
  writeAppFile(root, "routes/guide.mdx", "# Guide\n")
  writeAppFile(root, "routes/team.vue", "<template><p>team</p></template>\n")
  writeAppFile(root, "routes/help.svelte", "<p>help</p>\n")
  writeAppFile(
    root,
    "routes/_layout.tsx",
    `export default function Layout() {
  return (
    <nav>
      <a href="/guide">guide</a>
      <a href="/team">team</a>
      <a href="/help">help</a>
    </nav>
  )
}
`,
  )
  expect(await findings("NF-C057", "NF-C058")).toEqual([
    "NF-C058 routes/_layout.tsx:4 info",
    "NF-C058 routes/_layout.tsx:5 info",
    "NF-C058 routes/_layout.tsx:6 info",
  ])
})
