import { tryGetContext } from "@nifrajs/middleware/context-storage"
import { productTitle } from "../shell-lib/catalog.ts"

export const shellLoader = async () => ({ title: "shared" })

const stockEntry = { load: () => ({ left: 3 }), revalidate: 10 }

// The per-visitor hole reads the request; the shared ones join the shell's check.
export const boundaryLoaders = {
  cart: { load: () => ({ signedIn: tryGetContext() !== undefined }) },
  price: { load: () => ({ text: productTitle("1") }), revalidate: 30 },
  stock: stockEntry,
}
