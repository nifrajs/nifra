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
    // @ts-expect-error - the stream payload is contracted by the sse schema
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
  // @ts-expect-error - no such field on the event payload
  void event.missing
})
export type _SubIsSubscription = Expect<typeof subscription extends Subscription ? true : false>

// Ordinary routes do NOT grow a subscribe key.
export type _PlainHasNoSubscribe = Expect<"subscribe" extends keyof typeof api.plain ? false : true>

// The sse route still has its plain GET too.
export type _FeedKeepsGet = Expect<"get" extends keyof typeof api.feed ? true : false>

// A schema with a body makes the stream a POST route; its subscribe requires that body.
declare const promptSchema: StandardSchemaV1<{ prompt: string }, { prompt: string }>
declare const tokenSchema: StandardSchemaV1<unknown, { token: string }>
const chat = server().sse("/chat", { body: promptSchema, sse: tokenSchema }, (_c, stream) => {
  stream.send({ token: "hi" })
})
const chatApi = testClient<typeof chat>(chat)

const chatSubscription = chatApi.chat.subscribe(
  (event) => {
    const token: string = event.token
    void token
  },
  { body: { prompt: "hello" } },
)
export type _ChatIsSubscription = Expect<
  typeof chatSubscription extends Subscription ? true : false
>
// @ts-expect-error - a POST stream needs its body
chatApi.chat.subscribe(() => {})
// @ts-expect-error - the body is contracted by the body schema
chatApi.chat.subscribe(() => {}, { body: { prompt: 1 } })
// The POST stream is a POST route, not a GET one.
export type _ChatIsPost = Expect<"post" extends keyof typeof chatApi.chat ? true : false>
export type _ChatHasNoGet = Expect<"get" extends keyof typeof chatApi.chat ? false : true>
