import { serve } from "@nifrajs/node"
import { handle } from "./backend/isr.ts"

await serve({ fetch: handle }, { port: Number(process.env.PORT ?? 4315), hostname: "127.0.0.1" })
