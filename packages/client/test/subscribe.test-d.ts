/**
 * Type-level contract for typed SSE subscriptions: `app.sse()` routes grow `.subscribe()` with
 * the event payload typed from the `sse` schema; ordinary routes do NOT get a `subscribe` key.
 */

import type { StandardSchemaV1 } from "@nifrajs/core"
import { server } from "@nifrajs/core"
import type { Expect } from "@nifrajs/test-utils"
import type { Subscription } from "../src/index.ts"
import { testClient } from "../src/index.ts"

declare const postSchema: StandardSchemaV1<unknown, { id: number; title: string }>

const app = server()
  .sse("/feed", { sse: postSchema }, (_c, stream) => {
    stream.send({ id: 1, title: "typed" })
    // @ts-expect-error — the stream payload is contracted by the sse schema
    stream.send({ nope: true })
  })
  .get("/plain", () => ({ ok: true }))

const api = testClient<typeof app>(app)

// An sse route exposes subscribe, returning a Subscription, with the event typed from the schema.
const subscription = api.feed.subscribe((event) => {
  const id: number = event.id
  const title: string = event.title
  void id
  void title
  // @ts-expect-error — no such field on the event payload
  void event.missing
})
export type _SubIsSubscription = Expect<typeof subscription extends Subscription ? true : false>

// Ordinary routes do NOT grow a subscribe key.
export type _PlainHasNoSubscribe = Expect<"subscribe" extends keyof typeof api.plain ? false : true>

// The sse route still has its plain GET too.
export type _FeedKeepsGet = Expect<"get" extends keyof typeof api.feed ? true : false>
