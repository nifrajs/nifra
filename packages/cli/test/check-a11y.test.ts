import { afterEach, beforeEach, expect, test } from "bun:test"
import { collectCheckResult } from "../src/check.ts"
import {
  ABSTRACT_ROLES,
  ARIA_ATTRIBUTES,
  ARIA_VALUES,
  CONCRETE_ROLES,
  IMPLICIT_ROLES,
  NATIVE_FOR_ROLE,
  ROLE_REQUIRED,
} from "../src/internal/aria-data.ts"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

let root: string

beforeEach(() => {
  root = createFixtureRoot("tmp-check-a11y-")
})
afterEach(() => removeFixtureRoot(root))

interface Scanned {
  readonly line: number
  readonly code: string
  readonly kind: string
  readonly message: string
}

async function scan(): Promise<Scanned[]> {
  const result = await collectCheckResult(root, { lintsOnly: true })
  return result.diagnostics
    .filter((found) => found.code === "NF-C062" || found.code === "NF-C063")
    .map((found) => ({
      line: found.line ?? 0,
      code: found.code ?? "",
      kind: (found.evidence?.[0] ?? "").replace("kind: ", ""),
      message: found.message,
    }))
    .sort((a, b) => a.line - b.line)
}

/** A page of one JSX expression per line, so a finding's line says which case it belongs to. */
function page(cases: readonly string[], file = "routes/index.tsx"): readonly number[] {
  writeAppFile(
    root,
    file,
    `export default function Page(props: { x: string; n: number }) {\n  return [\n${cases.map((markup) => `    ${markup},`).join("\n")}\n  ]\n}\n`,
  )
  return cases.map((_, index) => index + 3)
}

const kinds = (found: readonly Scanned[]): string[] => found.map((one) => `${one.line} ${one.kind}`)

const REQUIRED_VALUE: Readonly<Record<string, string>> = {
  "aria-checked": "false",
  "aria-expanded": "false",
  "aria-level": "2",
  "aria-selected": "false",
  "aria-valuenow": "5",
}

const attributesFor = (role: string): string =>
  (ROLE_REQUIRED.get(role) ?? [])
    .map((name) => `${name}="${REQUIRED_VALUE[name] ?? "x"}"`)
    .join(" ")

test("the vocabulary is the one ARIA 1.2 defines", () => {
  expect(CONCRETE_ROLES.size).toBe(82)
  expect(ABSTRACT_ROLES.size).toBe(12)
  expect(ARIA_ATTRIBUTES.size).toBe(53)
  expect([...CONCRETE_ROLES].filter((role) => ABSTRACT_ROLES.has(role))).toEqual([])
  for (const role of ROLE_REQUIRED.keys()) expect(CONCRETE_ROLES.has(role)).toBe(true)
  for (const role of IMPLICIT_ROLES.values()) expect(CONCRETE_ROLES.has(role)).toBe(true)
  for (const role of NATIVE_FOR_ROLE.keys()) expect(CONCRETE_ROLES.has(role)).toBe(true)
  for (const name of ARIA_VALUES.keys()) expect(ARIA_ATTRIBUTES.has(name)).toBe(true)
  for (const names of ROLE_REQUIRED.values())
    for (const name of names) expect(ARIA_ATTRIBUTES.has(name)).toBe(true)
})

test("every concrete role is accepted with what it requires, and reported without it", async () => {
  const cases: string[] = []
  const expected: string[] = []
  for (const role of CONCRETE_ROLES) {
    const supplied = attributesFor(role)
    cases.push(`<p role="${role}" ${supplied} />`)
    for (const name of ROLE_REQUIRED.get(role) ?? []) {
      cases.push(`<p role="${role}" ${supplied.replace(`${name}=`, "data-x=")} />`)
      expected.push(`${cases.length + 2} missing-required`)
    }
  }
  page(cases)
  expect(kinds(await scan())).toEqual(expected)
})

test("a role with a fallback list is read by its first role the browser knows", async () => {
  page([
    '<p role="doc-chapter" />',
    '<p role="graphics-symbol" />',
    '<p role="nonsense alert" />',
    '<p role="presentation none" />',
    '<p role="" />',
    '<p role="nonsense" />',
    '<p role="widget alert" />',
    '<p role="widget" />',
  ])
  expect(kinds(await scan())).toEqual(["8 invalid-role", "10 abstract-role"])
})

test("every abstract role is refused, and every misspelled concrete role names its likeliest fix", async () => {
  const cases: string[] = []
  const expected: string[] = []
  for (const role of ABSTRACT_ROLES) {
    cases.push(`<p role="${role}" />`)
    expected.push(`${cases.length + 2} abstract-role`)
  }
  const fixes = new Map<number, string>()
  for (const role of CONCRETE_ROLES) {
    const typo = `${role}x`
    if (CONCRETE_ROLES.has(typo) || ABSTRACT_ROLES.has(typo)) continue
    cases.push(`<p role="${typo}" />`)
    expected.push(`${cases.length + 2} invalid-role`)
    fixes.set(cases.length + 2, role)
  }
  page(cases)
  const found = await scan()
  expect(kinds(found)).toEqual(expected)
  for (const one of found) {
    const fix = fixes.get(one.line)
    if (fix !== undefined) expect(one.message).toContain(`Did you mean "`)
  }
})

test("every ARIA attribute is accepted, and a misspelling of one is reported", async () => {
  const cases: string[] = []
  const expected: string[] = []
  for (const name of ARIA_ATTRIBUTES) cases.push(`<p ${name}={props.x} />`)
  for (const name of ARIA_ATTRIBUTES) {
    cases.push(`<p ${name}x={props.x} />`)
    expected.push(`${cases.length + 2} unknown-aria`)
  }
  cases.push("<p aria-labelledBy={props.x} />", "<p aria-LABEL={props.x} />")
  page(cases)
  const found = await scan()
  expect(kinds(found)).toEqual(expected)
  expect(found[0]?.message).toContain("is not an ARIA attribute")
})

test("every word an enumerated attribute takes is accepted and every other is reported", async () => {
  const cases: string[] = []
  const expected: string[] = []
  for (const [name, words] of ARIA_VALUES) {
    for (const word of words) cases.push(`<p ${name}="${word}" />`)
    cases.push(`<p ${name}={${JSON.stringify(words[0])}} />`)
    cases.push(`<p ${name}={props.x} />`)
    cases.push(`<p ${name} />`)
    cases.push(`<p ${name}="not-a-${name}" />`)
    expected.push(`${cases.length + 2} invalid-aria-value`)
    cases.push(`<p ${name}="${words[0]?.toUpperCase()}" />`)
  }
  page(cases)
  expect(kinds(await scan())).toEqual(expected)
})

test("a role an element already has is reported, a role it gains is not", async () => {
  const cases: string[] = []
  const expected: string[] = []
  for (const [tag, role] of IMPLICIT_ROLES) {
    cases.push(`<${tag} role="${role}" />`)
    expected.push(`${cases.length + 2} redundant-role`)
    cases.push(`<${tag} role="${role} none" />`)
    cases.push(`<${tag} role="presentation" />`)
  }
  cases.push('<a href="/x" role="link" />', '<a role="link" />', '<a href="/x" role="button" />')
  expected.push(`${cases.length + 2 - 2} redundant-role`)
  page(cases)
  const found = (await scan()).filter((one) => one.kind === "redundant-role")
  expect(kinds(found)).toEqual(expected)
})

test("a div or span built as a native control is reported, any other element is not", async () => {
  const cases: string[] = []
  const expected: string[] = []
  for (const role of NATIVE_FOR_ROLE.keys()) {
    for (const tag of ["div", "span"]) {
      cases.push(`<${tag} role="${role}" ${attributesFor(role)} />`)
      expected.push(`${cases.length + 2} native-element`)
    }
    cases.push(`<p role="${role}" ${attributesFor(role)} />`)
    cases.push(`<Div role="${role}" ${attributesFor(role)} />`)
  }
  page(cases)
  expect(kinds(await scan())).toEqual(expected)
})

test("an image without alt text is reported, one that says what it is or that it is decoration is not", async () => {
  const flagged = [
    '<img src="/a.png" />',
    "<img src={props.x} />",
    '<input type="image" src="/b.png" />',
    '<area href="/c" />',
  ]
  const clean = [
    '<img src="/a.png" alt="A chart of requests per second" />',
    '<img src="/a.png" alt="" />',
    "<img src={props.x} alt={props.x} />",
    '<img src="/a.png" role="presentation" />',
    '<img src="/a.png" role="none" />',
    '<img src="/a.png" {...props} />',
    '<input type="text" />',
    '<input type="image" alt="Go" />',
    "<area />",
    '<area href="/c" alt="Chapter" />',
    '<Img src="/a.png" />',
  ]
  page([...flagged, ...clean])
  expect(kinds(await scan())).toEqual(flagged.map((_, index) => `${index + 3} img-alt`))
})

test("a positive tabindex is reported in either spelling, any other is not", async () => {
  const flagged = ['<p tabindex="1" />', "<p tabIndex={5} />", '<p tabindex=" 3 " />']
  const clean = [
    '<p tabindex="0" />',
    '<p tabindex="-1" />',
    "<p tabIndex={0} />",
    "<p tabIndex={-1} />",
    "<p tabIndex={props.n} />",
    '<p tabindex="x" />',
  ]
  page([...flagged, ...clean])
  expect(kinds(await scan())).toEqual(["3 tabindex", "4 tabindex", "5 tabindex"])
})

test("an html element needs a language, written as text or as an expression", async () => {
  page([
    "<html />",
    '<html lang="en" />',
    "<html lang={props.x} />",
    "<html {...props} />",
    "<Html />",
  ])
  expect(kinds(await scan())).toEqual(["3 html-lang"])
})

test("an element with a spread, a component and a namespaced or custom tag are never judged", async () => {
  page([
    '<p role="nonsense" {...props} />',
    '<p {...props} role="nonsense" />',
    '<p aria-labeledby="x" {...props} />',
    '<p role="checkbox" {...props} />',
    '<Card role="nonsense" aria-labeledby="x" tabindex="9" />',
    '<my-card role="nonsense" aria-labeledby="x" />',
    '<svg:rect role="nonsense" />',
    "<p role={props.x} aria-hidden={props.n} />",
    "<p role={`checkbox`} />",
  ])
  expect(kinds(await scan())).toEqual(["11 missing-required"])
})

test("a native element that carries its own state needs no ARIA attribute for the role", async () => {
  page([
    '<input role="checkbox" />',
    '<input role="switch" />',
    '<input role="slider" />',
    '<input role="combobox" />',
    '<select role="combobox" />',
    '<option role="option" />',
    '<h2 role="heading" />',
    '<meter role="meter" />',
    '<p role="separator" />',
    '<p role="separator" tabindex="0" />',
    '<p role="separator" tabIndex={0} aria-valuenow="1" />',
  ])
  // <h2 role="heading"> is a repeat, but it is not missing aria-level: the element has its own.
  expect(kinds(await scan())).toEqual(["9 redundant-role", "12 missing-required"])
})

test("a nifra-expect comment accepts a finding only when it gives a reason", async () => {
  writeAppFile(
    root,
    "routes/index.tsx",
    `export default function Page() {
  return (
    <>
      {/* nifra-expect NF-C063: the canvas below is the only content */}
      <img src="/a.png" />
      {/* nifra-expect a11y: the design system forces this */}
      <p tabindex="2" />
      {/* nifra-expect a11y: a legacy widget kept until the redesign */}
      <div
        role="checkbox"
      />
      {/* nifra-expect NF-C063 */}
      <img src="/b.png" />
      {/* nifra-expect NF-C063: wrong code for this one */}
      <p role="nonsense" />
      <img src="/c.png" /> {/* nifra-expect NF-C063: trailing */}
    </>
  )
}
`,
  )
  const found = await scan()
  expect(kinds(found)).toEqual(["13 img-alt", "15 invalid-role"])
  expect(found[0]?.message).toContain("gives no reason")
})

test("a file under a test directory is left alone, and so is plain TypeScript", async () => {
  const cases = ['<p role="nonsense" />']
  page(cases, "test/fixtures/markup.tsx")
  writeAppFile(root, "src/plain.ts", 'export const text = `<p role="nonsense"></p>`\n')
  expect(await scan()).toEqual([])
})

test("both codes report as warnings and name the markup, so a project can retag either one", async () => {
  page(['<p role="nonsense" />', '<img src="/a.png" />'])
  const result = await collectCheckResult(root, { lintsOnly: true })
  const found = result.diagnostics.filter((one) => one.code === "NF-C062" || one.code === "NF-C063")
  expect(found.map((one) => [one.code, one.severity, one.file])).toEqual([
    ["NF-C062", "warning", "routes/index.tsx"],
    ["NF-C063", "warning", "routes/index.tsx"],
  ])
})
