import { expect, test } from "bun:test"
import { FRONTEND_GUIDANCE, parseAdapter, renderFrontendResult } from "../src/frontend-guidance.ts"

test("no args renders the full index with every entry id", () => {
  const index = renderFrontendResult({})
  expect(index).toContain(`${FRONTEND_GUIDANCE.length} of ${FRONTEND_GUIDANCE.length}`)
  for (const e of FRONTEND_GUIDANCE) expect(index).toContain(e.id)
})

test("a symptom query returns the matching entry in full (cause + fix + verify)", () => {
  const out = renderFrontendResult({ symptom: "hydration mismatch" })
  expect(out).toContain("[hydration-mismatch]")
  expect(out).toContain("Cause:")
  expect(out).toContain("Fix:")
  expect(out).toContain("Verify:")
})

test("adapter filter keeps that adapter's entries plus the shared seam entries", () => {
  const vue = renderFrontendResult({ adapter: "vue" })
  expect(vue).toContain("vue-lost-reactivity") // vue-specific
  expect(vue).toContain("server-import") // shared seam (adapters: all)
  expect(vue).not.toContain("solid-lost-reactivity") // another adapter's entry is filtered out
})

test("adapter filter narrows a symptom search to that adapter", () => {
  const out = renderFrontendResult({
    adapter: "solid",
    symptom: "value stopped updating reactivity",
  })
  expect(out).toContain("[solid-lost-reactivity]")
  expect(out).not.toContain("[vue-lost-reactivity]")
})

test("a seam entry points at a nifra tool; a framework entry points at its own linter", () => {
  const seam = renderFrontendResult({
    symptom: "server-only import leaked into a client component",
  })
  expect(seam).toContain("nifra_check")
  const framework = renderFrontendResult({ adapter: "react", symptom: "effect stale dependency" })
  expect(framework).toContain("eslint-plugin-react-hooks")
})

test("an unmatched symptom falls back to the (filtered) index, not an empty string", () => {
  const out = renderFrontendResult({ adapter: "svelte", symptom: "zzz-nonsense-token" })
  expect(out).toContain("No frontend-guidance entry matched")
  expect(out).toContain("svelte-runes") // the filtered index is still shown
})

test("parseAdapter normalizes case/whitespace and rejects non-adapters", () => {
  expect(parseAdapter("  VUE ")).toBe("vue")
  expect(parseAdapter("react")).toBe("react")
  expect(parseAdapter("angular")).toBeUndefined()
  expect(parseAdapter(undefined)).toBeUndefined()
})

test("every entry declares a non-empty adapters list and the core fields", () => {
  for (const e of FRONTEND_GUIDANCE) {
    expect(e.adapters.length).toBeGreaterThan(0)
    expect(e.symptom.length).toBeGreaterThan(0)
    expect(e.cause.length).toBeGreaterThan(0)
    expect(e.fix.length).toBeGreaterThan(0)
    expect(e.verify.length).toBeGreaterThan(0)
  }
})
