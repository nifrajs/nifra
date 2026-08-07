import type { DataContract, DataRequestFor, RlsScope, TypedDataPort } from "../src/data.ts"
import { createDataPort } from "../src/data.ts"

type Orders = DataContract<{
  list: {
    access: "read"
    input: { readonly limit: number }
    output: { readonly ids: readonly string[] }
  }
  save: {
    access: "write"
    input: { readonly id: string }
    output: { readonly ok: true }
  }
}>

declare const port: TypedDataPort<Orders>
declare const orders: Orders
const bound = createDataPort<Orders>(orders, port, {
  beacon: (_context, capability) => {
    const typed: "db.read" | "db.write" = capability
    void typed
  },
}).for({})
const scope: RlsScope = { token: "opaque-scope" }
const request: DataRequestFor<Orders, "list"> = {
  operation: "list",
  scope,
  capability: "db.read",
  input: { limit: 10 },
}
const output: Promise<{ readonly ids: readonly string[] }> = port.execute(request)
void output
const boundOutput: Promise<{ readonly ids: readonly string[] }> = bound.execute(request)
void boundOutput

// @ts-expect-error a read operation cannot claim write capability
port.execute({ ...request, capability: "db.write" })

// @ts-expect-error operation input remains typed at the adapter seam
port.execute({ ...request, input: { limit: "ten" } })
