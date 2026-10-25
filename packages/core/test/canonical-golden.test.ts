import { expect, test } from "bun:test"
import { serializeProjectEvidence } from "../src/evidence.ts"
import { canonicalizeIdempotencyBody, computeIdempotencyFingerprint } from "../src/idempotency.ts"
import { canonicalManifest, serializeNifraManifest } from "../src/manifest.ts"

// Manifests are signed, and evidence and fingerprints are stored: a byte change here breaks every
// artifact already written, so these outputs are pinned literally.

function fixture(undefinedMembers = false): Record<string, unknown> {
  const A: Record<string, unknown> = {
    nested: [true, false, [], {}],
    big: 12345678901234567000,
    frac: 0.1,
  }
  const value: Record<string, unknown> = {
    z: [3, { b: null, a: '\u00e9\u0000"\\\n' }],
    "\u00e9": -0,
    "10": 1e21,
    "9": 5e-324,
    A,
    "\ud83d\ude00": "\uffff\ud83d",
    "": "",
    constructor: "c",
    toJSON: "t",
  }
  Object.defineProperty(value, "__proto__", {
    value: { x: 1 },
    enumerable: true,
    writable: true,
    configurable: true,
  })
  value.np = Object.assign(Object.create(null), { b: 1, a: [2] })
  if (undefinedMembers) {
    value.omitted = undefined
    A.skipped = undefined
  }
  return value
}

/** The fixture, with undefined members, standing in for whichever artifact an entry point takes. */
function fixtureAs<T>(): T {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: these entry points encode the value as given and read none of its fields.
  return fixture(true) as T
}

const CANONICAL =
  '{"":"","10":1e+21,"9":5e-324,"A":{"big":12345678901234567000,"frac":0.1,"nested":[true,false,[],{}]},"__proto__":{"x":1},"constructor":"c","np":{"a":[2],"b":1},"toJSON":"t","z":[3,{"a":"\u00e9\\u0000\\"\\\\\\n","b":null}],"\u00e9":0,"\ud83d\ude00":"\uffff\\ud83d"}'

test("a manifest's canonical bytes are pinned", () => {
  expect(canonicalManifest({ manifestVersion: 1, routes: [fixtureAs()] })).toBe(
    `{"manifestVersion":1,"routes":[${CANONICAL}]}`,
  )
  expect(serializeNifraManifest(fixtureAs())).toBe(CANONICAL)
})

test("project evidence serializes to pinned bytes", () => {
  expect(serializeProjectEvidence(fixtureAs())).toBe(CANONICAL)
})

test("an idempotency body canonicalizes and fingerprints to pinned bytes", async () => {
  // Every number here has at most 15 significant digits and a short exponent, so a double holds it.
  const value: Record<string, unknown> = {
    z: [3, { b: null, a: '\u00e9\u0000"\\\n' }],
    "\u00e9": -0,
    "10": 1e21,
    A: { nested: [true, false, [], {}], frac: 0.1, max: 999999999999999 },
    "\ud83d\ude00": "\uffff\ud83d",
    "": "",
    constructor: "c",
    toJSON: "t",
  }
  Object.defineProperty(value, "__proto__", {
    value: { x: 1 },
    enumerable: true,
    writable: true,
    configurable: true,
  })
  const body = new TextEncoder().encode(
    ` { "b" : 1 , "neg" : -0 , "a" : ${JSON.stringify(value)} } `,
  )
  const canonical = canonicalizeIdempotencyBody(body, "application/json; charset=utf-8")
  expect(new TextDecoder().decode(canonical)).toBe(
    '{"a":{"":"","10":1e+21,"A":{"frac":0.1,"max":999999999999999,"nested":[true,false,[],{}]},"__proto__":{"x":1},"constructor":"c","toJSON":"t","z":[3,{"a":"\u00e9\\u0000\\"\\\\\\n","b":null}],"\u00e9":0,"\ud83d\ude00":"\uffff\\ud83d"},"b":1,"neg":0}',
  )
  expect(
    await computeIdempotencyFingerprint("post", "/orders?x=1", canonical, "application/json"),
  ).toBe("4e3f7aedb0e73d279db66d5d6f3d6ad7bc36f3643d19a3a5771bbec94ae06e17")
})
