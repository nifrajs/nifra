import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
import { formFor } from "../src/forms.ts"

const app = server()
  .post("/notes", { body: t.object({ title: t.string() }) }, () => ({ ok: true }))
  .put("/notes/:id", { body: t.object({ title: t.string() }) }, () => ({ ok: true }))
  .post("/users/:id", { body: t.object({ name: t.string() }) }, () => ({ ok: true }))
const f = formFor<typeof app>()("/notes")

describe("formFor - runtime pass-through", () => {
  test("the handle carries the route's own action and method", () => {
    expect(f.action).toBe("/notes")
    expect(f.method).toBe("post")
  })

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

  test("a path with params fills them into the action, encoded", () => {
    const edit = formFor<typeof app>()("/notes/:id", "put", { id: "a b/7" })
    expect(edit.action).toBe("/notes/a%20b%2F7")
    expect(edit.method).toBe("put")
  })

  test("a POST route with params may leave the method out and take the params second", () => {
    const post = formFor<typeof app>()("/users/:id", { id: "7" })
    expect(post.action).toBe("/users/7")
    expect(post.method).toBe("post")
  })

  test("a param left out or empty fails at the call, naming it", () => {
    // @ts-expect-error - the id is required
    expect(() => formFor<typeof app>()("/notes/:id", "put")).toThrow(/"id" is missing or empty/)
    expect(() => formFor<typeof app>()("/notes/:id", "put", { id: ".." })).toThrow(
      /"id" holds a value no path segment can carry/,
    )
  })
})
