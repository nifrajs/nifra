import { tryGetContext } from "@nifrajs/middleware/context-storage"

export const shellLoader = async () => ({ title: "shared" })

// Only a hole reads the request, which is where it belongs.
export const boundaryLoaders = {
  me: { load: () => ({ signedIn: tryGetContext() !== undefined }) },
}
