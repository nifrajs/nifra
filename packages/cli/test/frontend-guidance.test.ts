import { expect, test } from "bun:test"
import {
  FRONTEND_GUIDANCE,
  parseAdapter,
  renderFrontendResult,
  selectFrontendGuidance,
} from "../src/frontend-guidance.ts"

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
test("framework guidance carries version and authoritative source metadata", () => {
  for (const adapter of ["react", "preact", "solid", "vue", "svelte"] as const) {
    const entries = FRONTEND_GUIDANCE.filter((entry) => entry.adapters.includes(adapter))
    expect(entries.length).toBeGreaterThanOrEqual(4)
    expect(entries.filter((entry) => entry.versions !== undefined).length).toBeGreaterThanOrEqual(3)
    expect(
      entries.filter((entry) => entry.source?.startsWith("https://") === true).length,
    ).toBeGreaterThanOrEqual(3)
  }
})
test("structured guidance selection is stable for CLI and MCP consumers", () => {
  const selected = selectFrontendGuidance({ adapter: "solid", symptom: "list reorder state" })
  expect(selected.schemaVersion).toBe(1)
  expect(selected.matched).toBe(true)
  expect(selected.entries.map((entry) => entry.id)).toContain("solid-for-index")
})
test("selection covers optional metadata and ignores one-character noise", () => {
  const bySeeAlso = selectFrontendGuidance({ adapter: "all", symptom: "structure" })
  expect(bySeeAlso.entries.map((entry) => entry.id)).toContain("server-import")

  const byCategory = selectFrontendGuidance({ adapter: "vue", symptom: "effects" })
  expect(byCategory.entries.map((entry) => entry.id)).toContain("vue-watch-source")

  const byVersion = selectFrontendGuidance({ adapter: "vue", symptom: "3.5" })
  expect(byVersion.entries.map((entry) => entry.id)).toContain("vue-ref-script-access")

  const oneCharacter = selectFrontendGuidance({ symptom: "r" })
  expect(oneCharacter.matched).toBe(false)
  expect(oneCharacter.entries).toEqual([])
})

test("unknown adapter keeps the complete catalog and no-query result is matched", () => {
  const result = selectFrontendGuidance({ adapter: "angular" })
  expect(result.adapter).toBeUndefined()
  expect(result.matched).toBe(true)
  expect(result.entries).toHaveLength(FRONTEND_GUIDANCE.length)
})

test("full framework entries render their applicability and source", () => {
  const out = renderFrontendResult({ adapter: "vue", symptom: "watcher never runs" })
  expect(out).toContain("Applies: Vue 3.4-3.5")
  expect(out).toContain("Source:   https://vuejs.org/guide/essentials/watchers.html")
  expect(out).toContain("Category: effects")
})

test("seam entries do not print absent optional metadata", () => {
  const out = renderFrontendResult({ symptom: "server-only import leaked into client component" })
  expect(out).not.toContain("Category: undefined")
  expect(out).not.toContain("Source:   undefined")
})

test("an unmatched symptom falls back to the (filtered) index, not an empty string", () => {
  const out = renderFrontendResult({ adapter: "svelte", symptom: "zzz-nonsense-token" })
  expect(out).toContain("No frontend-guidance entry matched")
  expect(out).toContain("for svelte")
  expect(out).toContain("svelte-runes") // the filtered index is still shown

  const unfiltered = renderFrontendResult({ symptom: "zzz-nonsense-token" })
  expect(unfiltered).not.toContain("for undefined")
})

test("a matched symptom never uses the no-match fallback", () => {
  const out = renderFrontendResult({ adapter: "react", symptom: "effect stale dependency" })
  expect(out).toContain("[react-stale-deps]")
  expect(out).not.toContain("No frontend-guidance entry matched")
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

test("symptom text beyond the cap is ignored", () => {
  const padded = `${"x".repeat(300)} hydration`
  expect(selectFrontendGuidance({ symptom: padded }).matched).toBe(false)
  expect(selectFrontendGuidance({ symptom: "hydration" }).matched).toBe(true)
})

// Nifra-owned seam entries have no third-party framework doc to cite or version to scope.
const NIFRA_OWNED = new Set(["duplicate-runtime", "prefer-reactive-island", "swap-a-region"])

test("every framework entry carries versions and an https source; every non-universal entry a category", () => {
  for (const e of FRONTEND_GUIDANCE) {
    if (e.adapters.includes("all")) continue
    expect(e.category, `${e.id} category`).toBeDefined()
    if (NIFRA_OWNED.has(e.id)) continue
    expect(e.versions?.length ?? 0, `${e.id} versions`).toBeGreaterThan(0)
    expect(e.source?.startsWith("https://"), `${e.id} source`).toBe(true)
  }
})
