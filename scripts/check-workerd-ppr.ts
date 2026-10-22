#!/usr/bin/env bun
/**
 * Partially prerendered pages against a real local workerd: the shell streams before a held hole; a
 * gzipped document is encoded once with `compression()` installed; a hole is stopped by its deadline,
 * after a hang-up too; a shell one app built reaches another app of its deployment through KV and
 * never one of another deployment; a stale shell is rebuilt through waitUntil; a purge by tag reaches
 * every app; no shell build sees the visitor's async context; and the cancel beacon is off.
 */
import { join, resolve } from "node:path"
import { startWranglerDev } from "./wrangler-dev.ts"

const ROOT = resolve(import.meta.dir, "..")
const CONFIG = join(ROOT, "packages/web/test/workerd-ppr/wrangler.toml")
const WAIT_MS = 7_000
/** Local workerd compresses a response it is allowed to only once the response ends, so the
 * streaming steps ask for none. Not checked on Cloudflare's edge. */
const IDENTITY = { "accept-encoding": "identity" }

interface Probe {
  readonly builds: Readonly<Record<string, number>>
  readonly shellContexts: readonly unknown[]
  readonly holeStarts: number
  readonly holeAborts: number
  readonly waitedUntil: number
}

function check(step: string, ok: boolean, detail: unknown): void {
  if (!ok) throw new Error(`${step}: ${JSON.stringify(detail)}`)
}

const probeOf = async (origin: string): Promise<Probe> => (await fetch(`${origin}/__probe`)).json()

/** Polls the probe until `done` holds for it, for at most {@link WAIT_MS}. */
async function until(
  origin: string,
  step: string,
  done: (probe: Probe) => boolean,
): Promise<Probe> {
  const deadline = performance.now() + WAIT_MS
  for (;;) {
    const probe = await probeOf(origin)
    if (done(probe)) return probe
    if (performance.now() > deadline) throw new Error(`${step}: ${JSON.stringify(probe)}`)
    await Bun.sleep(20)
  }
}

/** Reads `body` until `done` holds for the text so far, for at most {@link WAIT_MS}. */
async function readUntil(
  step: string,
  body: ReadableStream<Uint8Array> | null,
  done: (text: string) => boolean,
): Promise<{ text: string; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  if (body === null) throw new Error(`${step}: no body`)
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const deadline = setTimeout(() => reader.cancel(new Error(`${step}: timed out`)), WAIT_MS)
  try {
    while (!done(text)) {
      const { value, done: ended } = await reader.read()
      if (ended) throw new Error(`${step}: the body ended first: ${text.slice(-300)}`)
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    clearTimeout(deadline)
  }
  return { text, reader }
}

const titleOf = (text: string): string => /<h1>([^<]*)<\/h1>/.exec(text)?.[1] ?? ""

async function streaming(origin: string): Promise<string[]> {
  const notes: string[] = []
  const hostSeen = (text: string) => text.includes('data-nifra-hole="cart"')

  const before = await probeOf(origin)
  const client = new AbortController()
  const res = await fetch(`${origin}/p/1?hold=1`, { headers: IDENTITY, signal: client.signal })
  check("no-store", res.headers.get("cache-control") === "private, no-store", [
    ...res.headers.entries(),
  ])
  const { text } = await readUntil("shell before the hole", res.body, hostSeen)
  check("shell before the hole", !text.includes("nifra-ppr:cart"), text.slice(-300))
  const hungUp = performance.now()
  client.abort()
  // Local workerd passes no hang-up to the Worker (a closed socket included), so the hole's 5 s
  // deadline is what stops it here.
  await until(origin, "the hole stops after a hang-up", (p) => p.holeAborts > before.holeAborts)
  const abortMs = Math.round(performance.now() - hungUp)
  notes.push(
    `the shell streams before a held hole; after a hang-up the hole stopped in ${abortMs} ms`,
  )

  const held = await fetch(`${origin}/p/2?hold=1`, { headers: IDENTITY })
  const first = await readUntil("shell before the release", held.body, hostSeen)
  check("shell before the release", !first.text.includes("nifra-ppr:cart"), first.text)
  await fetch(`${origin}/__release`)
  let rest = first.text
  for (;;) {
    const { value, done } = await first.reader.read()
    if (done) break
    rest += new TextDecoder().decode(value)
  }
  check("the held hole fills", rest.includes("cart 3 items"), rest.slice(-400))
  check("the beacon is off on Workers", rest.includes('"cancel":""'), rest.slice(-600))
  notes.push("a held hole fills after the shell; the beacon is off")

  // compression() leaves the body to the platform here, so the document is gzipped once.
  const zipped = await fetch(`${origin}/p/3`, { headers: { "accept-encoding": "gzip" } })
  const decoded = await zipped.text()
  check("gzip", zipped.headers.get("content-encoding") === "gzip", [...zipped.headers.entries()])
  check(
    "encoded once",
    decoded.includes("cart 3 items") && decoded.startsWith("<!doctype"),
    decoded.slice(0, 80),
  )
  notes.push("a gzipped document is encoded once with compression() installed")

  const deadlineBefore = await probeOf(origin)
  const timedOut = await (await fetch(`${origin}/d/1?hold=1`, { headers: IDENTITY })).text()
  check("the deadline's error frame", timedOut.includes("data-nifra-hole-error"), timedOut)
  await until(
    origin,
    "the deadline aborts the hole",
    (p) => p.holeAborts > deadlineBefore.holeAborts,
  )
  notes.push("a hole past its deadline is aborted and sends its error frame")
  return notes
}

async function shared(origin: string): Promise<string[]> {
  const notes: string[] = []
  const page = async (path: string, app: string): Promise<string> =>
    titleOf(
      await (
        await fetch(`${origin}${path}${path.includes("?") ? "&" : "?"}app=${app}`, {
          headers: IDENTITY,
        })
      ).text(),
    )
  const written = async (step: string, start: Probe) =>
    until(origin, step, (p) => p.waitedUntil > start.waitedUntil)

  let start = await probeOf(origin)
  const built = await page("/p/7", "a")
  await written("the shared write", start)
  const fromKv = await page("/p/7", "b")
  let probe = await probeOf(origin)
  check("b serves a's shell from KV", fromKv === built && probe.builds.b === start.builds.b, {
    built,
    fromKv,
    probe,
  })
  const other = await page("/p/7", "c")
  probe = await probeOf(origin)
  check("another deployment builds its own", probe.builds.c === start.builds.c + 1, {
    other,
    probe,
  })
  notes.push("a shell one app built is served by another of its deployment, never another's")

  start = await probeOf(origin)
  await page("/p/8", "a")
  await written("the second shared write", start)
  await fetch(`${origin}/__advance?ms=61000`)
  const stale = await page("/p/8", "b")
  await until(origin, "the rebuild behind a stale shell", (p) => p.builds.b > start.builds.b)
  check("the stale shell is served first", stale.includes('"a build'), stale)
  notes.push("a stale shared shell is served while waitUntil rebuilds it")

  start = await probeOf(origin)
  await page("/p/9", "a")
  await written("the third shared write", start)
  await fetch(`${origin}/__purge?tag=product:9`)
  const before = await probeOf(origin)
  await page("/p/9", "b")
  probe = await probeOf(origin)
  check("a purge reaches every app", probe.builds.b === before.builds.b + 1, probe)
  notes.push("a purge by tag drops the shared shell for every app")

  check(
    "no shell build sees the visitor",
    probe.shellContexts.every((context) => context === undefined || context === null),
    probe.shellContexts,
  )
  notes.push(`${probe.shellContexts.length} shell builds, none in a visitor's async context`)
  return notes
}

const dev = await startWranglerDev(CONFIG)
try {
  await dev.ready("/__nifra_ready__")
  const notes = [...(await streaming(dev.origin)), ...(await shared(dev.origin))]
  for (const note of notes) console.log(`✓ workerd partial prerendering: ${note}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  console.error(dev.logs())
  process.exitCode = 1
} finally {
  await dev.stop()
}
