import { expect, test } from "bun:test"
import { beforeHandler, server } from "../src/server.ts"

const guard = (name: string, log: string[]) => () => {
  log.push(name)
}

test("a beforeHandler hook runs after guards registered later in its scope", async () => {
  const log: string[] = []
  const app = server()
    .beforeHandle(guard("early", log))
    .use({ beforeHandle: beforeHandler(guard("last", log)) })
    .beforeHandle(guard("later", log))
    .use({ beforeHandle: guard("middleware", log) })
    .get("/", () => {
      log.push("handler")
      return "ok"
    })
  expect((await app.fetch(new Request("http://x/"))).status).toBe(200)
  expect(log).toEqual(["early", "later", "middleware", "last", "handler"])
})

test("beforeHandler hooks keep their own order, and a group's guards still go first", async () => {
  const log: string[] = []
  const app = server()
    .beforeHandle(beforeHandler(guard("first-last", log)))
    .use({ beforeHandle: beforeHandler(guard("second-last", log)) })
    .group("/g", (g) =>
      g.beforeHandle(guard("group", log)).get("/x", () => {
        log.push("handler")
        return "ok"
      }),
    )
  expect((await app.fetch(new Request("http://x/g/x"))).status).toBe(200)
  expect(log).toEqual(["group", "first-last", "second-last", "handler"])
})

test("a guard that refuses runs first, so a beforeHandler hook never sees the request", async () => {
  const log: string[] = []
  const app = server()
    .beforeHandle(beforeHandler(guard("last", log)))
    .beforeHandle(() => new Response("refused", { status: 403 }))
    .get("/", () => "ok")
  expect((await app.fetch(new Request("http://x/"))).status).toBe(403)
  expect(log).toEqual([])
})
