import { afterEach, beforeEach, expect, test } from "bun:test"
import { collectCheckResult } from "../src/check.ts"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

// The anchor scanner and the dead-link verdict, pinned one behaviour at a time: what a mutation of
// `rules/internal-links.ts` has to change for one of these to fail.

let root: string

beforeEach(() => {
  root = createFixtureRoot("tmp-check-internal-links-scan-")
})
afterEach(() => removeFixtureRoot(root))

const PAGE = "export default function Page() { return null }\n"
const BACKEND = `import { server } from "@nifrajs/core/server"
export const app = server().get("/api/health", () => ({ ok: true }))
`

function app(...routes: string[]): void {
  for (const route of routes) writeAppFile(root, `routes/${route}`, PAGE)
  writeAppFile(root, "backend/routes.ts", BACKEND)
}

/** A layout holding one anchor per line, the first on line 5. */
function layout(anchors: readonly string[]): void {
  writeAppFile(
    root,
    "routes/_layout.tsx",
    `export default function Layout(props: { id: string; s: string }) {
  const { id, s } = props
  return (
    <nav>
${anchors.map((anchor) => `      ${anchor}`).join("\n")}
    </nav>
  )
}
`,
  )
}

interface Finding {
  readonly code: string
  readonly file: string
  readonly line: number
  readonly message: string
  readonly evidence: string
}

async function scan(): Promise<Finding[]> {
  const result = await collectCheckResult(root, { lintsOnly: true })
  return result.diagnostics
    .filter((item) => item.code === "NF-C057" || item.code === "NF-C058")
    .map((item) => ({
      code: item.code ?? "",
      file: item.file ?? "",
      line: item.line ?? 0,
      message: item.message,
      evidence: (item.evidence ?? []).join("\n"),
    }))
}

const lines = (found: readonly Finding[], file?: string): string[] =>
  found
    .filter((item) => file === undefined || item.file === file)
    .map((item) => `${item.code}:${item.line}`)

test("a dead link names the page it is a typo of, within two edits", async () => {
  app("index.tsx", "pricing.tsx", "about.tsx", "docs.tsx", "blog.tsx")
  const probes: ReadonlyArray<readonly [string, string | undefined]> = [
    ["/pricng", "/pricing"], // one deletion
    ["/pricinng", "/pricing"], // one insertion
    ["/pricinf", "/pricing"], // one substitution
    ["/prcng", "/pricing"], // two deletions
    ["/prng", undefined], // three edits
    ["/abuot", "/about"], // a transposition is two edits
    ["/doc", "/docs"],
    ["/blag", "/blog"],
    ["/zzzzzz", undefined],
    ["/abc", undefined],
  ]
  layout(probes.map(([path]) => `<a href="${path}">x</a>`))
  const found = await scan()
  expect(found.map((item) => item.code)).toEqual(probes.map(() => "NF-C057"))
  probes.forEach(([path, near], index) => {
    const message = found.find((item) => item.line === 5 + index)?.message ?? ""
    expect(message, path).toContain(near === undefined ? "a 404." : `Did you mean ${near}?`)
    if (near === undefined) expect(message, path).not.toContain("Did you mean")
  })
})

test("a short path is not a typo of a long page, whatever the page set", async () => {
  app("pricing.tsx", "docs.tsx", "about.tsx")
  layout(['<a href="/q">x</a>', '<a href="/n">x</a>'])
  const found = await scan()
  expect(found.map((item) => item.code)).toEqual(["NF-C057", "NF-C057"])
  for (const finding of found) expect(finding.message).not.toContain("Did you mean")
})

test("two pages equally close to a typo: the first one found is named", async () => {
  app("ab.tsx", "ac.tsx")
  layout(['<a href="/ad">x</a>'])
  const [only] = await scan()
  expect(only?.message).toContain("Did you mean /ab?")
})

test("the suggested href() call carries the page's params, query and hash", async () => {
  app("index.tsx", "pricing.tsx", "users/[id].tsx")
  layout([
    '<a href="/pricing">a</a>',
    '<a href="/pricing?plan=pro">b</a>',
    '<a href="/pricing#faq">c</a>',
    '<a href="/pricing#">d</a>',
    '<a href="/pricing?a=1#faq">e</a>',
    '<a href="/users/7">f</a>',
    "<a href={`/users/${id}`}>g</a>",
    "<a href={`/pricing#${s}`}>h</a>",
    '<a href="/gone">i</a>',
  ])
  const found = await scan()
  const calls = [
    'href({ to: "/pricing" })',
    'href({ to: "/pricing", search: { … } })',
    'href({ to: "/pricing", hash: "faq" })',
    'href({ to: "/pricing" })',
    'href({ to: "/pricing", search: { … }, hash: "faq" })',
    'href({ to: "/users/:id", params: { id: "7" } })',
    'href({ to: "/users/:id", params: { id: … } })',
    'href({ to: "/pricing" })',
  ]
  calls.forEach((call, index) => {
    const finding = found.find((item) => item.line === 5 + index)
    expect(finding?.code).toBe("NF-C058")
    expect(finding?.message).toContain(`Build it with \`${call}\``)
  })
  for (const finding of found) expect(finding.message).not.toContain("undefined")
  const dead = found.find((item) => item.line === 13)
  expect(dead?.code).toBe("NF-C057")
  expect(dead?.message).toContain("links to a path no page of this app serves")
  expect(dead?.message).not.toContain("Did you mean")
})

test("a script anchor is told to keep itself with a // comment, a template anchor with an HTML one", async () => {
  app("index.tsx")
  layout(['<a href="/gone">x</a>'])
  writeAppFile(root, "routes/t.svelte", '<a href="/gone">x</a>\n')
  const found = await scan()
  const script = found.find((item) => item.file === "routes/_layout.tsx")
  const template = found.find((item) => item.file === "routes/t.svelte")
  expect(script?.evidence).toContain("`// nifra-expect NF-C057: <reason>` above the attribute")
  expect(script?.evidence).not.toContain("<!--")
  expect(template?.evidence).toContain("`<!-- nifra-expect NF-C057: <reason> -->` above the anchor")
})

test("a backend route path the router refuses does not take the rule down", async () => {
  app("index.tsx")
  writeAppFile(
    root,
    "backend/routes.ts",
    `import { server } from "@nifrajs/core/server"
export const app = server().get("/x/*{", () => "x").get("/api/health", () => ({ ok: true }))
`,
  )
  layout(['<a href="/gone">x</a>'])
  const result = await collectCheckResult(root, { lintsOnly: true })
  expect(result.diagnostics.map((item) => item.code)).not.toContain("NF-C017")
  expect(lines(await scan())).toEqual(["NF-C057:5"])
})

test("a framework file the scan cannot read leaves the mount unknown, whatever nifra.config says", async () => {
  app("index.tsx")
  layout(['<a href="/gone">x</a>'])
  expect(lines(await scan())).toEqual(["NF-C057:5"])

  // An unreadable prefix stays unreadable when the config file says nothing about it.
  writeAppFile(
    root,
    "backend/framework.ts",
    'export const apiPrefix = process.env.API_PREFIX ?? "/api"\n',
  )
  writeAppFile(root, "nifra.config.ts", "export const title = 1\n")
  expect(lines(await scan())).toEqual([])

  // A star re-export may supply the strip flag, which a literal prefix elsewhere does not settle.
  writeAppFile(root, "backend/framework.ts", 'export * from "./mount.ts"\n')
  writeAppFile(root, "nifra.config.ts", 'export const apiPrefix = "/api"\n')
  expect(lines(await scan())).toEqual([])

  // ...and neither does a literal strip flag settle a prefix it left open.
  writeAppFile(root, "nifra.config.ts", "export const apiStrip = false\n")
  expect(lines(await scan())).toEqual([])
})

test("an app whose routes/ holds no page, or whose public/ holds a folder, has no dead link there", async () => {
  writeAppFile(root, "routes/_layout.tsx", PAGE)
  writeAppFile(root, "backend/routes.ts", BACKEND)
  writeAppFile(root, "components/Nav.tsx", 'export const Nav = () => <a href="/anything">x</a>\n')
  expect(await scan()).toEqual([])
  // A rule that throws is reported as NF-C017, not as a finding.
  const result = await collectCheckResult(root, { lintsOnly: true })
  expect(result.diagnostics.map((item) => item.code)).not.toContain("NF-C017")

  writeAppFile(root, "routes/index.tsx", PAGE)
  writeAppFile(root, "public/downloads/guide.txt", "guide\n")
  writeAppFile(
    root,
    "components/Nav.tsx",
    'export const Nav = () => <><a href="/downloads">x</a><a href="/gone">y</a></>\n',
  )
  expect(lines(await scan())).toEqual(["NF-C057:1"])
})

test("a Svelte template is read around its expressions, quotes and script blocks", async () => {
  app("index.tsx")
  writeAppFile(
    root,
    "routes/s.svelte",
    `<script>
  const a = '<a href="/script-dead">'
</script >
<script module>let z = "<a href='/script2-dead'>"</script>
<style>a::after { content: "<a href='/style-dead'>" }</style>
<p>1 < 2 and 3 > 2 {}</p>
{ "}<a href='/expr-dead-1'>" }
{ '<a href="/expr-dead-2">' }
{ \`x\${ "}" }<a href="/expr-dead-3">\` }
{ "\\"}<a href='/expr-dead-4'>" }
{ {a: 1}.a }<a href="/real-1">r</a>
<div title="x > <a href='/attr-dead'>"><a href="/real-2">r</a></div>
<div title="C:\\"><a href="/real-3">r</a></div>
<p data-x=a\`b><a href="/real-4">r</a></p>
<div data={1 ><a href="/brace-dead">x</a>}><a href="/real-5">r</a></div>
<div class={a > b ? 1 : 2}><a href="/real-6">r</a></div>
<a href='/real-7'>r</a>`,
  )
  expect(lines(await scan())).toEqual([
    "NF-C057:11",
    "NF-C057:12",
    "NF-C057:13",
    "NF-C057:14",
    "NF-C057:15",
    "NF-C057:16",
    "NF-C057:17",
  ])
})

test("braces and quotes in a Svelte template hide an anchor, and a tag keeps its attributes", async () => {
  app("index.tsx")
  writeAppFile(
    root,
    "routes/m.svelte",
    `{ '}<a href="/e-dead-1">' }
{ {a:1}<a href="/e-dead-2">}
<div class={a} data-x="1 > <a href='/e-dead-3'>">y</div>
<div href="/e-dead-4">y</div>
<a href="/real-1">x</a>
{ x }<a href="/real-2">x</a>`,
  )
  expect(lines(await scan())).toEqual(["NF-C057:5", "NF-C057:6"])
})

test("a tag the file ends inside still ends the scan", async () => {
  app("index.tsx")
  writeAppFile(root, "routes/e.svelte", '<a href="/real-e">x</a>\n<a href="/in-tag"')
  expect(lines(await scan())).toContain("NF-C057:1")
})

test("a script tag the file ends inside does not send the scan back to an earlier script", async () => {
  app("index.tsx")
  writeAppFile(
    root,
    "routes/f.svelte",
    '<script>let a = 1</script>\n<a href="/real-f">x</a>\n<script defer',
  )
  expect(lines(await scan())).toEqual(["NF-C057:2"])
})

test("a path with a malformed escape is not served by anything", async () => {
  app("index.tsx")
  layout(['<a href="/bad%E0%A4%A">x</a>'])
  const [only] = await scan()
  expect(only?.code).toBe("NF-C057")
})

test("only an href with a path in it is an anchor's destination", async () => {
  app("index.tsx")
  layout([
    '<a href={"/gone-a"}>x</a>',
    "<a href={`/gone-b`}>x</a>",
    '<a href={id ? "/gone-c" : "/gone-d"}>x</a>',
    '<a href={"//cdn.example/x"}>x</a>',
    '<a href="docs/relative">x</a>',
    "<a href>x</a>",
    '<a {...props} data-href="/gone-e">x</a>',
    "<a href={}>x</a>",
    '<a href="/gone-f">x</a>',
  ])
  expect(lines(await scan())).toEqual(["NF-C057:5", "NF-C057:6", "NF-C057:13"])
})

test("a Vue template is read inside <template> only, and {{ }} holds expressions", async () => {
  app("index.tsx")
  writeAppFile(
    root,
    "routes/v.vue",
    `<template>
  <p>{{ "<a href='/vue-expr-dead'>" }} 1 < 2 { <a href="/real-v1">x</a> }</p>
  <template v-if="ok"><a :href="'/real-v2'">x</a></template>
  <a href="/real-v3">x</a><br>
  <a v-bind:href="'/real-v4'">x</a>
  <a :href="\`/real-v5\`">x</a>
  <a :href="dynamic">x</a>
  <a data-href="/data-dead" href="/real-v6">x</a>
  <a class="a" :href="'/a' + b">x</a>
  <a class="'/class-dead'" href="/real-v7">x</a>
  <div href="/div-dead">x</div>
</template>
<a href="/outside-dead">x</a>
<docs><a href="/docs-dead">x</a></docs>
`,
  )
  expect(lines(await scan())).toEqual([
    "NF-C057:2",
    "NF-C057:3",
    "NF-C057:4",
    "NF-C057:5",
    "NF-C057:6",
    "NF-C057:8",
    "NF-C057:10",
  ])
})

test("a comment that accepts the last anchor of a template holds without anything after it", async () => {
  app("index.tsx")
  writeAppFile(
    root,
    "routes/t.svelte",
    '<a href="/real-first">x</a>\n<!-- nifra-expect NF-C057: served by the CDN -->\n<a href="/accepted-last">x</a>',
  )
  expect(lines(await scan())).toEqual(["NF-C057:1"])
})

test("an unterminated comment or script ends the scan without hiding what came before", async () => {
  app("index.tsx")
  writeAppFile(
    root,
    "routes/c.svelte",
    '<a href="/real-c">x</a>\n<!-- never closes <a href="/in-comment">x</a>\n',
  )
  writeAppFile(
    root,
    "routes/d.svelte",
    '<a href="/real-d">x</a>\n<script>\n<a href="/in-script">x</a>\n',
  )
  const found = await scan()
  expect(lines(found, "routes/c.svelte")).toEqual(["NF-C057:1"])
  expect(lines(found, "routes/d.svelte")).toEqual(["NF-C057:1"])
})

test("a link on the last line of a template, with or without a final newline, keeps its line", async () => {
  app("index.tsx")
  const body = Array.from({ length: 12 }, (_, index) => `<p>row ${index + 1}</p>`)
  writeAppFile(root, "routes/a.svelte", `${body.join("\n")}\n<a href="/last-a">x</a>`)
  writeAppFile(root, "routes/b.svelte", `<a href="/first-b">x</a>\n${body.join("\n")}\n`)
  writeAppFile(root, "routes/c.svelte", `${body.join("\n")}\n<a href="/last-c">x</a>\n`)
  const found = await scan()
  expect(lines(found, "routes/a.svelte")).toEqual(["NF-C057:13"])
  expect(lines(found, "routes/b.svelte")).toEqual(["NF-C057:1"])
  expect(lines(found, "routes/c.svelte")).toEqual(["NF-C057:13"])
})

test("hidden folders, dependencies and test folders are not scanned for links", async () => {
  app("index.tsx")
  const dead = '<a href="/gone">x</a>\n'
  writeAppFile(root, ".cache/Comp.svelte", dead)
  writeAppFile(root, "node_modules/pkg/Comp.svelte", dead)
  writeAppFile(root, "test/Comp.svelte", dead)
  writeAppFile(root, "src/__tests__/Comp.vue", `<template>${dead}</template>`)
  writeAppFile(root, "components/Comp.svelte", dead)
  const tsx = 'export const L = () => <a href="/gone">x</a>\n'
  writeAppFile(root, "test/Links.tsx", tsx)
  writeAppFile(root, "src/__tests__/Links.tsx", tsx)
  writeAppFile(root, "components/Links.tsx", tsx)
  const found = await scan()
  expect(found.map((item) => item.file).sort()).toEqual([
    "components/Comp.svelte",
    "components/Links.tsx",
  ])
})
