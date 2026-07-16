// CLI-only build/dev configuration. The generated server imports `framework.ts`, not this file.
import react from "@vitejs/plugin-react"

export { adapter } from "./framework"
export const clientModule = "@nifrajs/web-react/client"
export const vitePlugins = [react()]
