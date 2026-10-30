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

test.each([
  "/api",
  "/api/",
  "/api/*",
  "/",
])("backend hrefs use the normalized stripped mount %s", async (prefix) => {
  pages()
  writeAppFile(
    root,
    "backend/framework.ts",
    `export const apiPrefix = ${JSON.stringify(prefix)}\nexport const apiStrip = true\n`,
  )
  writeAppFile(
    root,
    "backend/routes.ts",
    `import { server } from "@nifrajs/core/server"
export const app = server().get("/export", () => "csv").get("/", () => "root")
`,
  )
  const mounted = prefix === "/" ? "/export" : "/api/export"
  writeAppFile(
    root,
    "components/nav.tsx",
    `export const Nav = () => <nav>
  <a href="${mounted}">export</a>
  <a href="${prefix === "/" ? "/" : "/api"}">root</a>
  <a href="/missing">missing</a>
</nav>\n`,
  )
  expect(await findings("NF-C057")).toEqual(["NF-C057 components/nav.tsx:4 warning"])
})

test.each([
  "",
  "export const apiStrip = false\n",
])("a non-stripping mount keeps full registration paths (%s)", async (strip) => {
  pages()
  writeAppFile(root, "backend/framework.ts", `export const apiPrefix = "/api/"\n${strip}`)
  writeAppFile(
    root,
    "backend/routes.ts",
    `import { server } from "@nifrajs/core/server"
export const app = server().get("/export", () => "csv").get("/api/health", () => "ok")
`,
  )
  writeAppFile(
    root,
    "components/nav.tsx",
    `export const Nav = () => <nav>
  <a href="/api/health">health</a>
  <a href="/api/export">not prefixed automatically</a>
  <a href="/export">outside the mount</a>
</nav>\n`,
  )
  expect(await findings("NF-C057")).toEqual([
    "NF-C057 components/nav.tsx:3 warning",
    "NF-C057 components/nav.tsx:4 warning",
  ])
})

test.each([
  "export const apiPrefix = process.env.API_PREFIX\nexport const apiStrip = true\n",
  'export const apiPrefix = "/api"\nexport const apiStrip = Boolean(process.env.STRIP)\n',
  'export { apiPrefix, apiStrip } from "./mount"\n',
])("unknown mount config leaves dead verdicts open: %s", async (config) => {
  pages()
  writeAppFile(
    root,
    "backend/framework.ts",
    `${config}throw new Error("must not evaluate config")\n`,
  )
  writeAppFile(
    root,
    "components/nav.tsx",
    `export const Nav = () => <nav>
  <a href="/api/export">unknown mount</a>
  <a href="/pricing">page still checked</a>
</nav>\n`,
  )
  expect(await findings("NF-C057", "NF-C058")).toEqual(["NF-C058 components/nav.tsx:3 info"])
})

test("nifra.config mount fields override framework fields independently", async () => {
  pages()
  writeAppFile(
    root,
    "backend/framework.ts",
    'export const apiPrefix = "/old"\nexport const apiStrip = true\n',
  )
  writeAppFile(root, "nifra.config.ts", 'export const apiPrefix = "/api/"\n')
  writeAppFile(
    root,
    "backend/routes.ts",
    `import { server } from "@nifrajs/core/server"
export const app = server().get("/export", () => "csv")\n`,
  )
  writeAppFile(
    root,
    "components/nav.tsx",
    `export const Nav = () => <nav>
  <a href="/api/export">mounted</a>
  <a href="/old/export">old mount</a>
</nav>\n`,
  )
  expect(await findings("NF-C057")).toEqual(["NF-C057 components/nav.tsx:3 warning"])
})

test.each([
  "vue",
  "svelte",
])("%s only scans rendered anchors, preserving attribute lines", async (ext) => {
  pages()
  const content = `<script setup lang="ts" data-note=">">
const example = '<a href="/script-dead">example</a>'
const page = '<a href="/pricing">example</a>'
</script>
${ext === "vue" ? "<template>" : "<main>"}
<!-- <a href="/comment-dead">comment</a> -->
<!--
  <a href="/pricing">commented page</a>
-->
<div data-example='<a href="/attribute-dead">'>text</div>
<a title="1 > 0"
  href="/real-dead">real</a>
<a title="2 > 1" href="/pricing">page</a>
${ext === "vue" ? "</template>" : "</main>"}
<style>/* <a href="/style-dead"> */</style>
`
  writeAppFile(root, `routes/links.${ext}`, content)
  expect(await findings("NF-C057", "NF-C058")).toEqual([
    `NF-C057 routes/links.${ext}:12 warning`,
    `NF-C058 routes/links.${ext}:13 info`,
  ])
})

test.each([
  "vue",
  "svelte",
])("%s HTML expectations match source-rule suppression semantics", async (ext) => {
  pages()
  writeAppFile(
    root,
    `routes/links.${ext}`,
    `${ext === "vue" ? "<template>" : "<nav>"}
<!-- nifra-expect NF-C057: CDN serves this -->
<a
  href="/accepted">accepted</a>
<!-- nifra-expect NF-C058: stable marketing URL -->
<a href="/pricing">accepted page</a>
<!-- nifra-expect NF-C057 -->
<a href="/no-colon">source advisory accepts no reason</a>
<!-- nifra-expect NF-C057: -->
<a href="/empty-reason">source advisory accepts empty reason</a>
<!-- nifra-expect NF-C058: wrong code -->
<a href="/wrong-code">warn</a>
<!-- nifra-expect NF-C057-extra: not an exact code -->
<a href="/wrong-suffix">warn</a>
<!-- nifra-expect internal-link: alias -->
<a href="/alias">accepted alias</a>
<!--
  nifra-expect NF-C057: multi-line comment
-->
<!-- explanation continues -->
<a href="/block">accepted block</a>
<!-- nifra-expect NF-C057: not adjacent -->

<a href="/blank">warn</a>
<a href="/trailing">accepted</a> <!-- nifra-expect NF-C057: trailing -->
<a title="nifra-expect NF-C057: not a comment" href="/attribute">warn</a>
<!-- nifra-expect NF-C057: interrupted -->
<span>break</span>
<a href="/interrupted">warn</a>
${ext === "vue" ? "</template>" : "</nav>"}
`,
  )
  expect(await findings("NF-C057", "NF-C058")).toEqual([
    `NF-C057 routes/links.${ext}:12 warning`,
    `NF-C057 routes/links.${ext}:14 warning`,
    `NF-C057 routes/links.${ext}:24 warning`,
    `NF-C057 routes/links.${ext}:26 warning`,
    `NF-C057 routes/links.${ext}:29 warning`,
  ])
  const result = await collectCheckResult(root, { lintsOnly: true })
  const warning = result.diagnostics.find((item) => item.code === "NF-C057")
  expect(warning?.evidence?.join("\n")).toContain("<!-- nifra-expect NF-C057: <reason> -->")
  expect(warning?.evidence?.join("\n")).not.toContain("// nifra-expect")
})

test("an HTML comment ends at --> or --!>, and <!--> and <!---> are empty comments", async () => {
  pages()
  writeAppFile(
    root,
    "routes/links.vue",
    `<template>
<!-- nifra-expect NF-C057: closed by a bang --!>
<a href="/kept">kept</a>
<!-->
<a href="/after-empty">warn</a>
<!--->
<a href="/after-dash">warn</a>
</template>
`,
  )
  expect(await findings("NF-C057")).toEqual([
    "NF-C057 routes/links.vue:5 warning",
    "NF-C057 routes/links.vue:7 warning",
  ])
})
