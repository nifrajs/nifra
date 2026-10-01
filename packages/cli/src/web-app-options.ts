/**
 * The `createWebApp` options a CLI-run app takes from its framework config and `backend.ts`, built in
 * one place. `nifra dev`, the static prerender, `nifra mcp`'s render tool and the hydration gate each
 * construct the app themselves, and the generated server entry constructs it in production; when each
 * call site picked its own subset, the app they served drifted from the one that ships.
 */
import { inProcessClient } from "@nifrajs/client"
import type { CreateWebAppOptions } from "@nifrajs/web"
import { FRAMEWORK_WEB_OPTIONS, type FrameworkWebOption, type NifraFramework } from "./load.ts"

type FrameworkWebAppOptions = Pick<
  CreateWebAppOptions,
  "use" | "api" | "apiPrefix" | "apiStrip" | "mounts" | "csp" | "nonce"
>

/** `use`, the backend as `api`, and every forwarded framework field the config sets. */
export function frameworkWebAppOptions(
  fw: NifraFramework,
  backend: unknown,
): FrameworkWebAppOptions {
  const options: Record<string, unknown> = {}
  if (fw.use !== undefined) options.use = fw.use
  if (backend !== undefined) options.api = inProcessClient(backend as never)
  for (const name of FRAMEWORK_WEB_OPTIONS) {
    if (fw[name] !== undefined) options[name] = fw[name]
  }
  return options as FrameworkWebAppOptions
}

/**
 * The mount paths the app will serve ahead of page routing, read from the config alone (no app is
 * built): each `mounts` entry, plus the backend at `apiPrefix` when `backend.ts` exports one. A mount
 * added inside `use` is not visible here; `createWebApp` checks its own mount table at startup.
 */
export function frameworkMountPaths(fw: NifraFramework, hasBackend: boolean): string[] {
  const paths: string[] = []
  for (const mount of fw.mounts ?? []) {
    if (typeof mount?.path === "string") paths.push(mount.path)
  }
  const apiPrefix = fw.apiPrefix ?? "/api"
  if (hasBackend && apiPrefix !== "") paths.push(apiPrefix)
  return paths
}

/** The generated server entry's imports for the forwarded fields the config sets, all from the
 * edge-safe framework module. */
export function frameworkOptionImports(
  fw: NifraFramework,
  frameworkFile: string,
): { optionImports?: Partial<Record<FrameworkWebOption, string>> } {
  const imports: Partial<Record<FrameworkWebOption, string>> = {}
  for (const name of FRAMEWORK_WEB_OPTIONS)
    if (fw[name] !== undefined) imports[name] = frameworkFile
  return Object.keys(imports).length === 0 ? {} : { optionImports: imports }
}
