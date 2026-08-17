import { test } from "bun:test"
import { runContractLab } from "../../testing/src/contract-lab.ts"
import { server } from "../src/index.ts"

const app = server()
  .get("/lab/users/:id", (c) => {
    const url = new URL(c.request.url)
    return {
      id: c.params.id,
      tags: url.searchParams.getAll("tag"),
      lab: c.header("x-lab"),
    }
  })
  .post("/lab/echo", async (c) => c.request.json())
  .get(
    "/lab/created",
    () => new Response("created", { status: 201, headers: { "content-type": "text/plain" } }),
  )

test("the compact edge server satisfies the shared cross-runtime contract lab", async () => {
  await runContractLab(app)
})
