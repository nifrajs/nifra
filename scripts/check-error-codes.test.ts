import { expect, test } from "bun:test"
import { classify } from "../packages/web/src/diagnostic-catalog.ts"
import { countByPackage, readBaseline, regressions, scanUncoded } from "./check-error-codes.ts"

test("no framework package has more uncoded throws than recorded", () => {
  const { uncoded } = scanUncoded()
  expect(regressions(countByPackage(uncoded), readBaseline())).toEqual([])
})

test("the gate flags a package whose uncoded count rises, and a package it has not seen", () => {
  expect(regressions({ core: 54 }, { core: 53 })).toEqual(["core: 54 uncoded, recorded 53"])
  expect(regressions({ newpkg: 1 }, {})).toEqual(["newpkg: 1 uncoded, recorded 0"])
  expect(regressions({ core: 52 }, { core: 53 })).toEqual([])
})

test("a FrameworkError is judged by its message, not its code, and a code-shaped message is not exempt", () => {
  expect(
    classify("FrameworkError", "[nifra] app.sse() needs the streaming runtime", true).code,
  ).toBe("NIFRA_RUNTIME_MISSING")
  expect(classify("Error", "SOME_UNLISTED_CODE", true).code).toBe("NIFRA_UNHANDLED")
})

test("a message no entry recognises is uncoded, and a coded family is not", () => {
  expect(classify("Error", "a sentence nobody wrote a code for", true).code).toBe("NIFRA_UNHANDLED")
  expect(classify("Error", "effect ledger: invalid cost", true).code).not.toBe("NIFRA_UNHANDLED")
})
