// Build the client bundle (→ public/assets) for the auth demo. `bun run examples/auth-react/build.ts`.
import { buildClient } from "@nifrajs/web/build"

const manifest = await buildClient({
  routesDir: `${import.meta.dir}/routes`,
  outDir: `${import.meta.dir}/public/assets`,
  clientModule: "@nifrajs/web-react/client",
  conditions: ["bun", "browser"],
  define: { "process.env.NODE_ENV": '"production"' },
})
console.log("client entry:", manifest.entry)
