/** The differential app as a Workers module. There is no filesystem, so no static files. */
import { toFetchHandler } from "@nifrajs/core/edge"
import { createDifferentialApp } from "./app.ts"

export default toFetchHandler(createDifferentialApp())
