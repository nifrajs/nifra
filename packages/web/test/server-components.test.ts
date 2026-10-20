import { expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { componentValue } from "../src/server-components/schema.ts"
import type { ServerComponentContext } from "../src/server-components/types.ts"
import { defineServerComponent, prepareServerComponent } from "../src/server-components.ts"

function context(): ServerComponentContext {
  const request = new Request("https://fixture.test/products/example")
  return {
    request,
    req: request,
    params: { id: "example" },
    api: undefined,
    env: undefined,
    draft: false,
    live() {},
    search: {},
    set: { headers: {}, cookie() {}, deleteCookie() {} },
    signal: request.signal,
    data: null,
    layoutData: [],
  }
}

test("a server component projects public data before the view receives it", async () => {
  const component = defineServerComponent({
    input: t.object({ id: t.string() }),
    props: t.object({ name: t.string() }),
    authorize() {},
    load: () => ({ name: "Example", internalNote: "fabricated-private-field" }),
    view: ({ props }) => props.name,
  })
  const request = new Request("https://fixture.test/products/example")
  const prepared = await prepareServerComponent(
    component,
    { id: "example" },
    {
      request,
      req: request,
      params: { id: "example" },
      api: undefined,
      env: undefined,
      draft: false,
      live() {},
      search: {},
      set: { headers: {}, cookie() {}, deleteCookie() {} },
      signal: request.signal,
      data: null,
      layoutData: [],
    },
  )
  expect(prepared.props).toEqual({ name: "Example" })
  expect(component.view({ props: prepared.props })).toBe("Example")
})

test("invalid input never reaches authorization or load", async () => {
  const calls: string[] = []
  const component = defineServerComponent({
    input: t.object({ id: t.string() }),
    props: t.object({ name: t.string() }),
    authorize() {
      calls.push("authorize")
    },
    load() {
      calls.push("load")
      return { name: "Example" }
    },
    view: ({ props }) => props.name,
  })
  await expect(prepareServerComponent(component, { id: 1 }, context())).rejects.toMatchObject({
    code: "component_input",
  })
  expect(calls).toEqual([])
})

test("a denied authorizer prevents loading and rendering", async () => {
  let calls = 0
  const component = defineServerComponent({
    input: t.object({}),
    props: t.object({ name: t.string() }),
    authorize() {
      throw new Response(null, { status: 403 })
    },
    load() {
      calls++
      return { name: "Example" }
    },
    view: ({ props }) => props.name,
  })
  await expect(prepareServerComponent(component, {}, context())).rejects.toMatchObject({
    status: 403,
  })
  expect(calls).toBe(0)
})

test("cancellation after authorization prevents loading", async () => {
  const controller = new AbortController()
  let calls = 0
  const component = defineServerComponent({
    input: t.object({}),
    props: t.object({}),
    authorize() {
      controller.abort()
    },
    load() {
      calls++
      return {}
    },
    view: () => null,
  })
  await expect(
    prepareServerComponent(component, {}, { ...context(), signal: controller.signal }),
  ).rejects.toMatchObject({ code: "component_cancelled" })
  expect(calls).toBe(0)
})

test("DTOs reject symbol fields, accessors, sparse arrays and custom array prototypes", () => {
  const symbolField = { [Symbol("hidden")]: "fabricated-secret" }
  const sparse = new Array(1)
  const custom = Object.setPrototypeOf(["public"], { toJSON: () => "fabricated-secret" })
  for (const value of [
    symbolField,
    sparse,
    custom,
    {
      get value() {
        throw new Error("accessor ran")
      },
    },
  ]) {
    expect(() => componentValue(value)).toThrow()
  }
})

test("DTO validation copies public objects and enforces a bounded collection", () => {
  const value = { items: ["public"] }
  const publicValue = componentValue(value)
  value.items[0] = "changed"
  expect(publicValue).toEqual({ items: ["public"] })
  expect(() => componentValue(Array.from({ length: 100000 }, () => null))).toThrow()
})
