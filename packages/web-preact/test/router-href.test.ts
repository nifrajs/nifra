import { expect, test } from "bun:test"
import { href, rawHref } from "@nifrajs/web"
import * as router from "../src/router.ts"

test("the router entry exports the web package's href and rawHref", () => {
  expect(Object.is(router.href, href)).toBe(true)
  expect(Object.is(router.rawHref, rawHref)).toBe(true)
})
