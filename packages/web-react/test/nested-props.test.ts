import { expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { guardComponentProps } from "@nifrajs/web/server-components/props"
import { NestedServerComponent } from "../src/server-components/nested.props.ts"

// The schema the hand-written one replaced: both must answer every value the same way.
const reference = t.object({ instance: t.string(), html: t.string() })

const settle = (schema: typeof reference | typeof NestedServerComponent, value: unknown) =>
  guardComponentProps(schema, value).then(
    (props) => ({ props }),
    (error: unknown) => ({ refused: error instanceof Error ? error.constructor.name : "thrown" }),
  )

test("the nested host's props schema guards like the t.object it replaced", async () => {
  expect(NestedServerComponent.jsonSchema).toEqual(JSON.parse(JSON.stringify(reference.jsonSchema)))
  const values = [
    { instance: "i1", html: "<p>x</p>" },
    { instance: "i1", html: "x", extra: 1 },
    { instance: "i1" },
    { instance: 1, html: "x" },
    { instance: "i1", html: null },
    null,
    ["i1", "x"],
    "i1",
  ]
  for (const value of values) {
    expect(await settle(NestedServerComponent, value)).toEqual(await settle(reference, value))
  }
  expect(await settle(NestedServerComponent, values[0])).toEqual({ props: values[0] })
  expect(await settle(NestedServerComponent, values[1])).toEqual({
    props: { instance: "i1", html: "x" },
  })
})
