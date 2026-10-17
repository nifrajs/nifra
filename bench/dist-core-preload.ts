import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const sourceRoot = fileURLToPath(new URL("../packages/core/src/", import.meta.url))
const distRoot = fileURLToPath(new URL("../packages/core/dist/", import.meta.url))

// Match the explicit dist app imports when built middleware resolves its own core dependencies.
Bun.plugin({
  name: "nifra-benchmark-dist-core",
  setup(build) {
    // Bun's runtime skips onResolve for bare imports; intercept the resolved source file instead.
    build.onLoad({ filter: /[/\\]packages[/\\]core[/\\]src[/\\].*\.tsx?$/ }, ({ path }) => {
      const modulePath = relative(sourceRoot, path)
      if (modulePath.startsWith("..") || isAbsolute(modulePath)) {
        return {
          contents: readFileSync(path, "utf8"),
          loader: path.endsWith(".tsx") ? "tsx" : "ts",
        }
      }
      const target = resolve(distRoot, modulePath.replace(/\.tsx?$/, ".js"))
      if (!existsSync(target)) throw new Error(`benchmark core import has no built file: ${path}`)
      return { contents: `export * from ${JSON.stringify(target)}`, loader: "js" }
    })
  },
})
