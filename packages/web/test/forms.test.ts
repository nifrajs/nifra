import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
import { formFor } from "../src/forms.ts"

const app = server().post("/notes", { body: t.object({ title: t.string() }) }, () => ({ ok: true }))
const f = formFor<typeof app, "/notes">()

describe("formFor — runtime pass-through", () => {
  test("field() returns { name } merged with extra props", () => {
    expect(f.field("title")).toEqual({ name: "title" })
    expect(f.field("title", { id: "title", defaultValue: "" })).toEqual({
      id: "title",
      defaultValue: "",
      name: "title",
    })
  })

  test("extra props never override the typed name", () => {
    expect(f.field("title", { name: "oops" } as Record<string, unknown>)).toEqual({ name: "title" })
  })

  test("read() / readAll() delegate to FormData", () => {
    const fd = new FormData()
    fd.append("title", "a")
    fd.append("title", "b")
    expect(f.read(fd, "title")).toBe("a")
    expect(f.readAll(fd, "title")).toEqual(["a", "b"])
    expect(f.read(new FormData(), "title")).toBeNull()
  })
})
