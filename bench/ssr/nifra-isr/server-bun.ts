import { handle } from "./backend/isr.ts"

Bun.serve({ port: Number(Bun.env.PORT ?? 4313), hostname: "127.0.0.1", fetch: handle })
