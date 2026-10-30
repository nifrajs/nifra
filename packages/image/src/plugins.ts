/** Build-only `?image` imports for Bun and Vite. Both consume the same Node-compatible processor. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  createImageAssets,
  type ImageAssets,
  type ImageBuildAsset,
  type ImageBuildOptions,
} from "./build.ts"

export interface ImageAssetPlugin {
  /** Nifra emits these content-hashed files with the bundle, never into the application's sources. */
  nifraStaticAssets(): readonly ImageBuildAsset[]
}

interface ImageBunBuild {
  onResolve(
    options: { filter: RegExp },
    handler: (args: { path: string; resolveDir: string; importer: string }) => { path: string },
  ): void
  onLoad(
    options: { filter: RegExp },
    handler: (args: { path: string }) => Promise<{ contents: string; loader: "js" }>,
  ): void
}

/** Structural Bun hooks keep the shared plugin entry usable without Bun's ambient types. */
export interface ImageBunPlugin extends ImageAssetPlugin {
  readonly name: string
  setup(build: ImageBunBuild): void
}

const IMAGE_IMPORT = /\.(?:png|jpe?g|webp|gif)\?image(?:&|$)/i
const matches = (id: string): boolean => IMAGE_IMPORT.test(id)
const sourceFile = (id: string): string => {
  const path = id.split("?", 1)[0] ?? id
  return path.startsWith("file:") ? fileURLToPath(path) : resolve(path)
}
async function moduleSource(
  images: ImageAssets,
  file: string,
  options?: ImageBuildOptions,
): Promise<string> {
  const data = await images.load(file)
  if (options !== undefined && process.env.NIFRA_DEV_HMR === "1") {
    // Bun's HTML bundler owns a separate plugin instance. Publish to the ignored dev cache so its
    // images are available before the background leak-check build has run.
    const cache = resolve(
      process.env.NIFRA_DEV_ROOT ?? options.root ?? process.cwd(),
      ".nifra/image-assets",
    )
    for (const asset of images.assets()) {
      const path = join(cache, asset.fileName)
      if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, asset.source)
      }
    }
  }
  return `export default ${JSON.stringify(data)}\n`
}

/** Install in both clientPlugins and serverPlugins; no codec is loaded unless explicitly supplied. */
export function imageBunPlugin(options: ImageBuildOptions = {}): ImageBunPlugin {
  const images = createImageAssets(options)
  return {
    name: "nifra-image",
    nifraStaticAssets: () => images.assets(),
    setup(build) {
      images.clear()
      build.onResolve({ filter: IMAGE_IMPORT }, (args) => ({
        path: resolve(args.resolveDir || dirname(args.importer), args.path),
      }))
      build.onLoad({ filter: IMAGE_IMPORT }, async (args) => ({
        contents: await moduleSource(images, sourceFile(args.path), options),
        loader: "js",
      }))
    },
  }
}

interface ImageDevRequest {
  readonly url?: string | undefined
  readonly method?: string | undefined
}
interface ImageDevResponse {
  setHeader(name: string, value: string): unknown
  end(data?: Uint8Array): unknown
}
interface ImageDevServer {
  readonly middlewares: {
    use(handler: (req: ImageDevRequest, res: ImageDevResponse, next: () => void) => void): unknown
  }
}
interface ImageLoadContext {
  addWatchFile(file: string): void
}

/** Structural Vite plugin type: the image package does not depend on Vite at runtime. */
export interface ImageVitePlugin extends ImageAssetPlugin {
  readonly name: string
  readonly enforce: "pre"
  configResolved(): void
  load(this: ImageLoadContext, id: string): Promise<string | undefined>
  configureServer(server: ImageDevServer): void
}

/** Use in vitePlugins for both development and production; the dev middleware serves hashed bytes. */
export function imageVitePlugin(options: ImageBuildOptions = {}): ImageVitePlugin {
  const images = createImageAssets(options)
  const publicPath = options.publicPath ?? "/assets/"
  const prefix = publicPath.endsWith("/") ? publicPath : `${publicPath}/`
  return {
    name: "nifra-image",
    enforce: "pre",
    nifraStaticAssets: () => images.assets(),
    configResolved() {
      images.clear()
    },
    async load(id) {
      if (!matches(id)) return undefined
      const file = sourceFile(id)
      this.addWatchFile(file)
      return moduleSource(images, file)
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          next()
          return
        }
        const path = new URL(req.url ?? "/", "http://nifra.local").pathname
        const asset = images.assets().find((file) => `${prefix}${file.fileName}` === path)
        if (asset === undefined) {
          next()
          return
        }
        const extension = asset.fileName.slice(asset.fileName.lastIndexOf(".") + 1)
        res.setHeader("content-type", `image/${extension === "jpg" ? "jpeg" : extension}`)
        res.setHeader("cache-control", "public, max-age=31536000, immutable")
        res.setHeader("x-content-type-options", "nosniff")
        res.end(req.method === "HEAD" ? undefined : asset.source)
      })
    },
  }
}
