import { expect, test } from "bun:test"
import type { StandardResult, StandardSchemaV1, StandardTypes } from "@nifrajs/core"
import { server } from "@nifrajs/core"
import { defineContract } from "@nifrajs/core/contract"
import {
  type ActionArgs,
  type ActionData,
  inProcessClient,
  type LoaderArgs,
  type LoaderData,
} from "../src/index.ts"

const backend = server().get("/users/:id", (c) => ({ id: c.params.id, name: "Ada" }))
const api = inProcessClient(backend)

// Coupled: a typed loader via the annotation (a pure type → tree-shakes out of client bundles).
async function load({ api, params }: LoaderArgs<typeof backend>) {
  const res = await api.users({ id: params.id ?? "" }).get()
  // @ts-expect-error res.data is typed from the contract — there is no `bogus` field
  void res.data?.bogus
  return { user: res.data }
}

test("inProcessClient + a typed loader resolve data in-process (no network)", async () => {
  const data = await load({
    params: { id: "7" },
    request: new Request("http://x"),
    req: new Request("http://x"),
    api,
    env: undefined,
    draft: false,
  })
  expect(data).toEqual({ user: { id: "7", name: "Ada" } })
})

// LoaderData inference (type-level): the loader's return shape, not any/unknown.
type _Data = LoaderData<typeof load>
const _ok: _Data = { user: { id: "1", name: "Ada" } }
// @ts-expect-error LoaderData is an object here, not a string
const _bad: _Data = "nope"
void _ok
void _bad

// Typed env (type-level): LoaderArgs<Api, Env> + ActionArgs<Api, Env> thread Env into the `env` field.
interface DemoEnv {
  readonly KV: { get(k: string): Promise<string | null> }
}
const _loaderEnv: LoaderArgs<typeof backend, DemoEnv>["env"] = { KV: { get: async () => null } }
const _actionEnv: ActionArgs<typeof backend, DemoEnv>["env"] = _loaderEnv // ActionArgs threads Env too
// @ts-expect-error - NOPE is not a key of DemoEnv
void _loaderEnv.NOPE
void _actionEnv

// --- Graduation: the SAME loader shape, typed from a CONTRACT instead of `typeof backend`. ---
function schema<O>(validate: (v: unknown) => StandardResult<O>): StandardSchemaV1<unknown, O> {
  // minimal Standard Schema for the type-level demo
  const types = undefined as unknown as StandardTypes<unknown, O>
  return { "~standard": { version: 1, vendor: "nifra-test", validate, types } }
}
const userOut = schema<{ id: string; name: string }>((v) => ({
  value: v as { id: string; name: string },
}))
const contract = defineContract({
  getUser: { method: "GET", path: "/users/:id", response: userOut },
})

// Only the type argument changed (typeof backend → typeof contract) — the body is identical.
async function loadGraduated({ api, params }: LoaderArgs<typeof contract>) {
  const res = await api.users({ id: params.id ?? "" }).get()
  // @ts-expect-error api is typed from the contract's response — there is no `bogus` field
  void res.data?.bogus
  return { user: res.data }
}
type _GData = LoaderData<typeof loadGraduated>
const _gok: _GData = { user: { id: "1", name: "Ada" } }
void _gok
void loadGraduated

// --- Actions: ActionArgs gives a typed api/params/request; ActionData excludes a Response return ---
async function act({ api, params, request }: ActionArgs<typeof backend>) {
  const body = await request.formData()
  if (!body.get("name")) return new Response("name required", { status: 400 })
  const res = await api.users({ id: params.id ?? "" }).get()
  // @ts-expect-error api is typed from the contract — there is no `bogus` field
  void res.data?.bogus
  return { ok: true as const, name: String(body.get("name")) }
}

test("an action with ActionArgs runs in-process and returns its data branch", async () => {
  const data = await act({
    params: { id: "7" },
    request: new Request("http://x", {
      method: "POST",
      body: new URLSearchParams({ name: "Ada" }),
    }),
    req: new Request("http://x"),
    api,
    env: undefined,
    draft: false,
  })
  expect(data).toEqual({ ok: true, name: "Ada" })
})

// ActionData drops the Response branch — only the data shape reaches the page's `actionData`.
type _AData = ActionData<typeof act>
const _aok: _AData = { ok: true, name: "Ada" }
// @ts-expect-error a Response is excluded from ActionData
const _abad: _AData = new Response()
void _aok
void _abad
