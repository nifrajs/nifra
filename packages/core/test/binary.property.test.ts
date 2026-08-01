import { expect, test } from "bun:test"
import fc from "fast-check"
import { bytes } from "../src/binary.ts"

const PROPERTY_OPTIONS = { numRuns: 500, seed: 0xb1a4f1e }
const utf16String = fc
  .array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 80 })
  .map((units) => String.fromCharCode(...units))

test("property: arbitrary UTF-16 filenames always produce one safe Content-Disposition value", () => {
  fc.assert(
    fc.property(utf16String, (filename) => {
      let response: Response | undefined
      expect(() => {
        response = bytes(new Uint8Array(), { filename })
      }).not.toThrow()

      const disposition = response?.headers.get("content-disposition")
      expect(disposition).not.toBeNull()
      expect(disposition).not.toContain("\r")
      expect(disposition).not.toContain("\n")
      expect(disposition).toMatch(
        /^attachment; filename="[^"\\\r\n]*"(?:; filename\*=UTF-8''[A-Za-z0-9!#$&+.^_`|~%-]*)?$/,
      )
    }),
    PROPERTY_OPTIONS,
  )
})
