import assert from "node:assert/strict"
import { test } from "node:test"
import { parseJsonGuarded } from "../../core/src/server/proto-guard.ts"

test("the Node JSON guard clears pending work after rejection and preserves strip/ignore policies", () => {
  const siblings = JSON.stringify(Array.from({ length: 512 }, () => ({ safe: { value: 1 } })))
  for (const poison of [
    '"__proto__":{"admin":true}',
    '"constructor":{"prototype":{"admin":true}}',
  ]) {
    const text = `${siblings.slice(0, -1)},{${poison},"ok":true}]`
    assert.throws(() => parseJsonGuarded(text, "reject"), /json_proto_poisoning/)
    assert.deepEqual(parseJsonGuarded('{"clean":true}', "reject"), { clean: true })
    const stripped = parseJsonGuarded(text, "strip")
    assert.ok(Array.isArray(stripped))
    assert.equal(stripped.length, 513)
    assert.deepEqual(stripped.at(-1), { ok: true })
    const ignored = parseJsonGuarded(text, "ignore")
    assert.ok(Array.isArray(ignored))
    assert.equal(
      Object.hasOwn(ignored.at(-1), poison.startsWith('"__proto__"') ? "__proto__" : "constructor"),
      true,
    )
    assert.deepEqual(parseJsonGuarded('[{"clean":true}]', "reject"), [{ clean: true }])
  }
})

test("the Node guard remains iterative for deeply nested JSON", () => {
  const depth = 20000
  const text = `${'{"child":'.repeat(depth)}{"__proto__":{"admin":true},"ok":1}${"}".repeat(depth)}`
  assert.throws(() => parseJsonGuarded(text, "reject"), /json_proto_poisoning/)
  let cursor = parseJsonGuarded(text, "strip")
  for (let i = 0; i < depth; i++) {
    assert.ok(cursor !== null && typeof cursor === "object" && "child" in cursor)
    cursor = cursor.child
  }
  assert.deepEqual(cursor, { ok: 1 })
})
