import { tryGetContext } from "@nifrajs/middleware/context-storage"

// Reads the visitor's request through async context: refused by the shell check.
export const shellLoader = async () => ({ signedIn: tryGetContext() !== undefined })
