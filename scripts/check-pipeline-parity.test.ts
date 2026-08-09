import { expect, test } from "bun:test"
import { compareParity, formatParityReport, type ParitySnapshot } from "./check-pipeline-parity.ts"

const snapshot = (overrides: Partial<ParitySnapshot> = {}): ParitySnapshot => ({
  routeManifest: ["_layout", "about", "index"],
  routeChunks: { about: 1, index: 2 },
  staticAssets: ["js:entry", "js:route:about:0", "js:route:index:0", "public:/robots.txt"],
  cssModuleClassMaps: { box: "styles_box_hash" },
  ...overrides,
})

test("pipeline parity reports a clean logical contract", () => {
  expect(compareParity(snapshot(), snapshot())).toEqual([])
  expect(formatParityReport([])).toContain("Pipeline parity: PASS")
})

test("pipeline parity fails when a route is dropped", () => {
  const differences = compareParity(
    snapshot(),
    snapshot({ routeManifest: ["_layout", "index"], routeChunks: { index: 2 } }),
  )
  expect(differences.map((difference) => difference.section)).toContain("route-manifest")
  expect(differences.map((difference) => difference.section)).toContain("route-chunks")
  expect(formatParityReport(differences)).toContain("route-manifest: FAIL")
})

test("pipeline parity fails when a CSS Module value changes", () => {
  const differences = compareParity(
    snapshot(),
    snapshot({ cssModuleClassMaps: { box: "other_hash" } }),
  )
  expect(differences).toEqual([
    {
      section: "css-module-class-maps",
      bun: { box: "styles_box_hash" },
      vite: { box: "other_hash" },
    },
  ])
})
