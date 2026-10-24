import { expect, test } from "bun:test"
import { machineSurfaceFor, securityTxt } from "../site/backend/machine-surfaces.ts"

test("security.txt names SECURITY.md's contacts and expires 180 days after the day it is served", async () => {
  const text = securityTxt(Date.UTC(2026, 9, 24, 15, 30))
  expect(text).toContain("Contact: mailto:security@nifra.dev\n")
  expect(text).toContain("Contact: https://github.com/nifrajs/nifra/security/advisories/new\n")
  expect(text).toContain("Expires: 2027-04-22T00:00:00.000Z\n")
  const response = machineSurfaceFor(new Request("https://nifra.dev/.well-known/security.txt"))
  expect(response?.headers.get("content-type")).toBe("text/plain; charset=utf-8")
  expect(await response?.text()).toStartWith("Contact: ")
})
