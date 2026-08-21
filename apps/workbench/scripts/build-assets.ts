/**
 * Copy the static Workbench shell into the build output next to the bundled browser module.
 *
 * `build:browser` emits `dist/public/app.js`; this step places `index.html` beside it so the server
 * serves both from a single `dist/public` asset root in dev and prod.
 */

import { copyFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

const packageRoot = join(import.meta.dir, "..")
const source = join(packageRoot, "public/index.html")
const target = join(packageRoot, "dist/public/index.html")

await mkdir(dirname(target), { recursive: true })
await copyFile(source, target)
console.log(`workbench: copied ${source} -> ${target}`)
