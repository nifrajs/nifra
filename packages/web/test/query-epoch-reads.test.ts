/**
 * A response that rotates the identity epoch cookie sends no signal. Every way into the query client
 * hears it as the page reads, so nothing the previous visitor loaded is served to the next.
 */
import { describe, expect, test } from "bun:test"
import { createQueryClient, type QueryClient, type QueryHandle } from "../src/query.ts"

// The epoch is read once per synchronous run, so a rotation takes a task of its own to be seen.
async function afterRotation(
  run: (rotate: () => Promise<void>) => void | Promise<void>,
): Promise<void> {
  const described = Object.getOwnPropertyDescriptor(globalThis, "document")
  const cookies = { cookie: "nifra-epoch=0" }
  let rotations = 0
  Object.defineProperty(globalThis, "document", { value: cookies, configurable: true })
  try {
    await run(async () => {
      await Promise.resolve()
      cookies.cookie = `nifra-epoch=${++rotations}`
      await Promise.resolve()
    })
  } finally {
    if (described === undefined) Reflect.deleteProperty(globalThis, "document")
    else Object.defineProperty(globalThis, "document", described)
  }
}

type Way = (client: QueryClient, held: QueryHandle<string>, load: () => Promise<string>) => unknown

const ways: Record<string, Way> = {
  "query()": (client, _, load) => client.query(["new"], load),
  "fetch()": (_, held) => held.fetch(),
  "refetch()": (_, held) => held.refetch(),
  "invalidateQueries()": (client) => client.invalidateQueries(["nothing", "matches"]),
  "getQueryData()": (client) => client.getQueryData(["new"]),
  "setQueryData()": (client) => client.setQueryData(["new"], "set"),
  "prefetchQuery()": (client, _, load) => client.prefetchQuery(["new"], load),
  "dehydrate()": (client) => client.dehydrate({ shouldDehydrateQuery: () => true }),
  "hydrate()": (client) => client.hydrate({ queries: [] }),
  "infiniteQuery()": (client) =>
    client.infiniteQuery(["pages"], async (page: number) => page, {
      initialPageParam: 0,
      getNextPageParam: () => undefined,
    }),
}

describe("a new identity epoch cookie", () => {
  for (const [name, way] of Object.entries(ways))
    test(`is heard by ${name}: what the previous visitor loaded is gone`, async () => {
      await afterRotation(async (rotate) => {
        const client = createQueryClient({ now: () => 0, staleTime: 1_000_000 })
        let loads = 0
        const load = async (): Promise<string> => `loaded-${++loads}`
        const held = client.query(["held"], load)
        const other = client.query(["other"], async () => "other")
        await Promise.all([held.fetch(), other.fetch()])
        expect(other.snapshot().data).toBe("other")
        await rotate()
        const result = await way(client, held, load)
        switch (name) {
          case "query()":
          case "infiniteQuery()":
            expect(result).toHaveProperty("snapshot")
            break
          case "fetch()":
          case "refetch()":
            expect(result).toBe("loaded-2")
            break
          case "dehydrate()":
            expect(result).toMatchObject({ queries: [] })
            break
          default:
            expect(result).toBeUndefined()
        }
        expect(other.snapshot().data).toBeUndefined()
      })
    })

  test("is heard by a paged query's hasNextPage() and refetch()", async () => {
    await afterRotation(async (rotate) => {
      const client = createQueryClient({ now: () => 0, staleTime: 1_000_000 })
      const options = {
        initialPageParam: 0,
        getNextPageParam: (_: number, pages: readonly number[]) => pages.length,
      }
      const paged = client.infiniteQuery(["pages"], async (page: number) => page, options)
      const other = client.query(["other"], async () => "other")
      await Promise.all([paged.fetchNextPage(), other.fetch()])
      await rotate()
      expect(paged.hasNextPage()).toBe(false)
      expect(other.snapshot().data).toBeUndefined()
      await other.fetch()
      await rotate()
      await paged.refetch()
      expect(other.snapshot().data).toBeUndefined()
    })
  })
})
