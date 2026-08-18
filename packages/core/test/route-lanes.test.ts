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

  test("preserves lifecycle sublanes and the derive-before specialization", () => {
    const hooks = selectRouteLanes({ ...base, derives: 1, beforeHandle: 1 })
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
    expect(bodyQuery).toMatchObject({ lane: "lifecycle", lifecycleLane: "body-query" })
    expect(around).toMatchObject({ lane: "bare", fusedLane: undefined })
  })
})
