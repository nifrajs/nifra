import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

test("built benchmark middleware shares the app's one built core", async () => {
  const preload = fileURLToPath(new URL("./dist-core-preload.ts", import.meta.url))
  const app = fileURLToPath(new URL("./http-realworld/_nifra-app.ts", import.meta.url))
  const probe = `
    const { makeNifraApp } = await import(${JSON.stringify(app)});
    const response = await makeNifraApp().fetch(new Request("http://bench/api/orders?limit=10", {
      headers: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz", cookie: "theme=dark", origin: "https://app.example.com" }
    }));
    console.log(JSON.stringify({ status: response.status, copies: Reflect.get(globalThis, Symbol.for("nifra.core.copies")) }));
  `
  const proc = Bun.spawn(["bun", "--preload", preload, "--eval", probe], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(exitCode, stderr).toBe(0)
  expect(stderr).not.toContain("loaded 2 times")
  expect(stdout).toContain('"status":200')
  expect(stdout).not.toContain("/src/")
  expect(stdout.match(/core-copies\.js/g)).toHaveLength(1)
})
