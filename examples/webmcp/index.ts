import { toMcpTool } from "@nifrajs/mcp/tool-contract"
import { t } from "@nifrajs/schema"
import {
  createPredictionStore,
  defineAgentCapability,
  executePredicted,
  registerWebMcpTools,
  type WebMcpRegistrationReport,
} from "@nifrajs/webmcp"

export interface CartItem {
  readonly sku: string
  readonly quantity: number
}

export interface CartState {
  readonly items: readonly CartItem[]
}

const addToCartInput = t.object({ sku: t.string({ minLength: 1 }), quantity: t.number() })
const addToCartOutput = t.object({ cartVersion: t.string() })

/** One canonical capability: schemas, core admission, WebMCP, MCP, and predictive UI share it. */
export const addToCart = defineAgentCapability<
  typeof addToCartInput,
  typeof addToCartOutput,
  CartState
>({
  name: "cart.add",
  description: "Add a product to the current cart.",
  input: addToCartInput,
  output: addToCartOutput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  writes: ["cart"],
  execute: async (input) => addItemOnServer(input),
  predict: ({ input, version }) => ({
    baseVersion: version,
    patch: [{ op: "add", path: "/items/-", value: input }],
  }),
  reconcile: ({ previous, input, output }) => ({
    state: {
      items: [...previous.state.items, { sku: input.sku, quantity: input.quantity }],
    },
    version: output.cartVersion,
  }),
})

/** The page-local WebMCP registration; unsupported hosts return a safe no-op report. */
export function installCartTools(): Promise<WebMcpRegistrationReport> {
  return registerWebMcpTools([addToCart])
}

/** The existing remote MCP projection; no second schema or handler is introduced. */
export const remoteCartTool = toMcpTool(addToCart.tool, {
  capabilities: [addToCart.tool.capability],
})

/** The same capability can drive a human UI's optimistic state without involving a model. */
export function addWithPrediction(input: CartItem) {
  const store = createPredictionStore<CartState>({ state: { items: [] }, version: "cart-1" })
  return executePredicted(addToCart, input, store)
}

// The application supplies its authenticated server call here. It is deliberately not a browser
// credential or a public package implementation detail.
declare function addItemOnServer(input: CartItem): Promise<{ cartVersion: string }>
