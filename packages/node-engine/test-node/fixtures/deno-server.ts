import { serve } from "@nifrajs/deno"
import { makeApp } from "./parity-app.ts"

const running = await serve(makeApp(), { port: 0, hostname: "127.0.0.1" })
console.log(running.port)
