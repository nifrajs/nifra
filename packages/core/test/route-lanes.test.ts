import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { selectRouteLanes } from "../src/internal/route-lanes.ts"

const base = {
  schema: undefined,
  hasIdempotency: false,
  hasLedger: false,
  hasResponseContract: false,
  hasDecorations: false,
  derives: 0,
  beforeHandle: 0,
  afterHandle: 0,
  onError: 0,
  around: 0,
  defaultOnValidationError: false,
} as const

describe("selectRouteLanes", () => {
  test("keeps a bare route on the bare fused lane", () => {
    expect(selectRouteLanes({ ...base, schema: undefined })).toMatchObject({
      bare: true,
      lane: "bare",
      fusedLane: "bare",
      fusedQuery: false,
      fusedBody: false,
    })
  })

  test("keeps query-only and body-only routes fused", () => {
    const query = selectRouteLanes({ ...base, schema: { query: t.object({ q: t.string() }) } })
    const body = selectRouteLanes({ ...base, schema: { body: t.object({ name: t.string() }) } })
    expect(query).toMatchObject({
      lane: "query",
      fusedQuery: true,
      fusedLane: "query",
    })
    expect(body).toMatchObject({
      lane: "body",
      bodyOnly: true,
      fusedBody: true,
      fusedLane: "body",
    })
  })

  test("drops a fused lane when idempotency or response enforcement needs the generic path", () => {
    const idempotent = selectRouteLanes({
      ...base,
      hasIdempotency: true,
      schema: { body: t.object({ name: t.string() }) },
    })
    const contracted = selectRouteLanes({
      ...base,
      hasResponseContract: true,
      schema: { body: t.object({ name: t.string() }) },
    })
    expect(idempotent).toMatchObject({
      lane: "body",
      bodyOnly: true,
      fusedBody: false,
      fusedLane: undefined,
    })
    expect(contracted).toMatchObject({
      lane: "lifecycle",
      bodyOnly: false,
      fusedBody: false,
    })
  })

  test("preserves lifecycle sublanes and the derive-before specializations", () => {
    const hooks = selectRouteLanes({ ...base, derives: 1, beforeHandle: 1 })
    const hooksAfter = selectRouteLanes({ ...base, derives: 1, beforeHandle: 1, afterHandle: 1 })
    const hooksAfterChain = selectRouteLanes({
      ...base,
      derives: 1,
      beforeHandle: 1,
      afterHandle: 2,
    })
    const bodyQuery = selectRouteLanes({
      ...base,
      derives: 1,
      beforeHandle: 1,
      schema: { body: t.object({ name: t.string() }), query: t.object({ q: t.string() }) },
    })
    const around = selectRouteLanes({ ...base, around: 1, schema: undefined })
    expect(hooks).toMatchObject({
      lane: "lifecycle",
      lifecycleLane: "hooks",
      lifecycleHookLane: "derive-before",
    })
    expect(hooksAfter).toMatchObject({
      lane: "lifecycle",
      lifecycleLane: "hooks",
      lifecycleHookLane: "derive-before-after",
    })
    expect(hooksAfterChain.lifecycleHookLane).toBeUndefined()
    expect(bodyQuery).toMatchObject({ lane: "lifecycle", lifecycleLane: "body-query" })
    expect(around).toMatchObject({ lane: "bare", fusedLane: undefined })
  })

  test("fuses body lifecycle routes only when the complete shape is eligible", () => {
    const body = { body: t.object({ name: t.string() }) }
    expect(selectRouteLanes({ ...base, schema: body, derives: 1, beforeHandle: 1 })).toMatchObject({
      lane: "lifecycle",
      fusedLane: "body-derive-before",
    })
    expect(
      selectRouteLanes({ ...base, schema: body, derives: 1, beforeHandle: 1, afterHandle: 1 }),
    ).toMatchObject({
      lane: "lifecycle",
      fusedLane: "body-derive-before-after",
    })
  })

  test("does not fuse lifecycle routes that need generic wrappers or recovery", () => {
    const query = { query: t.object({ q: t.string() }) }
    const recovery = {
      ...query,
      onValidationError: () => ({ q: "fallback" }),
    }
    const cases = [
      selectRouteLanes({ ...base, derives: 1, beforeHandle: 1, around: 1 }),
      selectRouteLanes({ ...base, derives: 1, beforeHandle: 1, hasLedger: true }),
      selectRouteLanes({ ...base, schema: recovery, derives: 1, beforeHandle: 1 }),
      selectRouteLanes({
        ...base,
        schema: query,
        derives: 1,
        beforeHandle: 1,
        defaultOnValidationError: true,
      }),
    ]
    for (const lanes of cases) expect(lanes.fusedLane).toBeUndefined()
  })
})
