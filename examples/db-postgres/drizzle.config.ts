import { defineConfig } from "drizzle-kit"

// `bunx drizzle-kit generate` reads this to emit SQL migrations into ./migrations from schema.ts.
export default defineConfig({
  schema: "./schema.ts",
  out: "./migrations",
  dialect: "postgresql",
})
