import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { copyPublicDir } from "../src/build.ts"
import { publicUrlPaths } from "../src/internal/public-url.ts"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nifra-public-url-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test("a plain name is listed once", () => {
  expect(publicUrlPaths("img/logo.png")).toEqual(["/img/logo.png"])
  expect(publicUrlPaths("report,2026+v2.csv")).toEqual(["/report,2026+v2.csv"])
})

test("a name holding ; [ ] | is listed in both spellings", () => {
  expect(publicUrlPaths("a[1];b|c.png")).toEqual(["/a%5B1%5D%3Bb%7Cc.png", "/a[1];b|c.png"])
})

// The static mount compares the raw request path to this list. Whatever a page links - the spelling
// this framework writes or the one a browser sends for the text - must be in it.
test("copyPublicDir lists every path a browser may request for each file", async () => {
  const from = join(root, "public")
  const to = join(root, "out")
  mkdirSync(join(from, "dir"), { recursive: true })
  for (const name of ["plain.txt", "a[1];b|c.png", "dir/x,y+z.css", "café.txt"]) {
    writeFileSync(join(from, name), "x")
  }
  const copied = await copyPublicDir(from, to)
  expect(copied).toEqual([
    "/a%5B1%5D%3Bb%7Cc.png",
    "/a[1];b|c.png",
    "/caf%C3%A9.txt",
    "/dir/x,y+z.css",
    "/plain.txt",
  ])
  for (const request of [
    "/a[1];b|c.png",
    "/a%5B1%5D%3Bb%7Cc.png",
    "/caf%C3%A9.txt",
    "/dir/x,y+z.css",
  ]) {
    expect(copied).toContain(new URL(request, "http://x").pathname)
  }
})
