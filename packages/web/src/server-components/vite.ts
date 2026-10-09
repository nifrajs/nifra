import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import ts from "typescript"
import { type Plugin, version as viteVersion } from "vite"
import {
  compileComponentModule,
  componentReference,
  directive,
  exportedValues,
  guardCreateElementCalls,
  sourceFile,
} from "./source.ts"

const componentFile = /\.component\.server\.[cm]?[jt]sx?$/
const islandFile = /\.island\.[cm]?[jt]sx?$/
const referencePrefix = "\0nifra-component-reference:"
const nativeQuery = "nifra-native-client-reference"
const reactRuntime = "\0nifra-component-react-runtime"
const bare = (id: string): string => id.split("?")[0] ?? id

export interface ServerComponentsPluginOptions {
  readonly root: string
  readonly adapter: "react" | "vue" | "svelte" | "solid" | "preact"
}

function nativeFacade(source: string, file: string): string {
  const prefix = file.replace(/\.[cm]?[jt]sx?$/, ".props.")
  const extensions = /\.[cm]?jsx?$/.test(file)
    ? ["js", "mjs", "cjs", "ts"]
    : ["ts", "mts", "cts", "js"]
  const companion =
    extensions.map((extension) => prefix + extension).find(existsSync) ?? prefix + extensions[0]
  if (!existsSync(companion))
    throw new Error(
      `[nifra/components] ${file} requires ${companion}: export a closed props schema for every native client component`,
    )
  const schemas = sourceFile(readFileSync(companion, "utf8"), companion)
  const registered = new Set(exportedValues(schemas))
  const slots = new Map<string, readonly string[]>()
  for (const statement of schemas.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.name.text.endsWith("Slots")) continue
      let value = declaration.initializer
      if (value !== undefined && ts.isAsExpression(value)) value = value.expression
      if (
        value === undefined ||
        !ts.isArrayLiteralExpression(value) ||
        !value.elements.every(ts.isStringLiteral)
      )
        throw new Error("[nifra/components] Managed slot names must be a literal array")
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The compiler inspects trusted AST/package metadata and its own populated stub map; application data never supplies these values.
      const names = value.elements.map((node) => (node as ts.StringLiteral).text)
      if (
        names.some(
          (name) =>
            !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ||
            name === "ref" ||
            name === "key" ||
            name === "constructor",
        )
      )
        throw new Error("[nifra/components] Invalid managed slot name")
      slots.set(declaration.name.text.slice(0, -5), names)
    }
  }
  const names = exportedValues(sourceFile(source, file))
  const exports = names.map((name, index) => {
    if (!registered.has(name))
      throw new Error(
        `[nifra/components] Native client export ${name} in ${file} has no registered props schema`,
      )
    if (name !== "default" && !/^[$A-Z_a-z][$\w]*$/.test(name))
      throw new Error("[nifra/components] Native client export names must be identifiers")
    const local = `__nifra_client_${index}`
    const value = `__guard(__native[${JSON.stringify(name)}], __schemas[${JSON.stringify(name)}], ${JSON.stringify(slots.get(name) ?? [])})`
    return name === "default"
      ? `const ${local} = ${value}; export default ${local};`
      : `export const ${name} = ${value};`
  })
  return [
    'import { guardedClientReference as __guard } from "@nifrajs/web-react/server-components/guard";',
    `import * as __native from ${JSON.stringify(`${file}?${nativeQuery}`)};`,
    `import * as __schemas from ${JSON.stringify(companion)};`,
    ...exports,
  ].join("\n")
}

/** Compiler bridge. The ordinary build must continue rejecting arbitrary server imports. */
export function serverComponentsPlugin(
  options: ServerComponentsPluginOptions,
): Plugin & { readonly api: { readonly componentModules: ReadonlySet<string> } } {
  const stubs = new Map<string, string>()
  const internal = new Set<string>()
  const nativeReferences = new Set<string>()
  const componentModules = new Set<string>()
  return {
    api: { componentModules },
    name: "nifra:server-components",
    enforce: "pre",
    configResolved(config) {
      if (viteVersion !== "8.2.1")
        throw new Error(
          "[nifra/components] Use the certified Vite 8.2.1 component pipeline; Bun remains a supported server runtime",
        )
      if (options.adapter === "react") {
        const require = createRequire(resolve(config.root, "package.json"))
        const versions = ["react", "react-dom", "react-server-dom-webpack"].map((name) => {
          try {
            // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The compiler inspects trusted AST/package metadata and its own populated stub map; application data never supplies these values.
            return (require(`${name}/package.json`) as { version: string }).version
          } catch {
            throw new Error(
              `[nifra/components] Install ${name}@19.2.8 for the React component pipeline`,
            )
          }
        })
        if (versions.some((version) => version !== "19.2.8"))
          throw new Error(
            "[nifra/components] React, React DOM, and Flight must all use the matching 19.2.8 version",
          )
      }
    },
    async resolveId(source, importer) {
      const environment = this.environment.name
      if (source === "react" && environment === "rsc" && !internal.has(bare(importer ?? ""))) {
        internal.add(reactRuntime)
        const guard = await this.resolve("@nifrajs/web-react/server-components/guard", importer, {
          skipSelf: true,
        })
        if (guard !== null) internal.add(bare(guard.id))
        return reactRuntime
      }
      if (source.startsWith("\0virtual:vite-rsc/") && environment !== "rsc") return null
      if (source.startsWith("@nifrajs/web-react/server-components/")) {
        const resolved = await this.resolve(source, importer, { skipSelf: true })
        if (resolved !== null) internal.add(bare(resolved.id))
        return resolved
      }
      if (source.includes(nativeQuery)) {
        const file = source.startsWith("/@fs/")
          ? source.slice(4)
          : existsSync(bare(source))
            ? source
            : resolve(options.root, `.${source}`)
        if (
          !nativeReferences.has(bare(file)) ||
          (environment === "rsc" && (importer === undefined || bare(importer) !== bare(file)))
        )
          throw new Error(
            "[nifra/components] Raw native client references are compiler-owned; import the registered client component",
          )
        return file
      }
      if (source.startsWith(referencePrefix) || source.startsWith("\0")) return null
      if (
        environment === "rsc" &&
        options.adapter === "react" &&
        (source === "react/jsx-runtime" || source === "react/jsx-dev-runtime") &&
        !internal.has(bare(importer ?? ""))
      ) {
        const resolved = await this.resolve(
          `@nifrajs/web-react/server-components/${source.endsWith("dev-runtime") ? "jsx-dev-runtime" : "jsx-runtime"}`,
          importer,
          { skipSelf: true },
        )
        if (resolved === null)
          throw new Error("[nifra/components] Install the matching @nifrajs/web-react adapter")
        internal.add(bare(resolved.id))
        const guard = await this.resolve("@nifrajs/web-react/server-components/guard", importer, {
          skipSelf: true,
        })
        if (guard !== null) internal.add(bare(guard.id))
        return resolved
      }
      if (environment !== "client") return null
      const resolved = await this.resolve(source, importer, { skipSelf: true })
      if (resolved === null || !componentFile.test(bare(resolved.id))) return null
      if (resolved.id !== bare(resolved.id))
        throw new Error("[nifra/components] Server component source cannot be imported as an asset")
      const compiled = compileComponentModule(
        readFileSync(resolved.id, "utf8"),
        resolved.id,
        options.root,
        "client",
      )
      const id = referencePrefix + componentReference(resolved.id, options.root, "module")
      stubs.set(id, compiled.code)
      return id
    },
    load(id) {
      if (id === reactRuntime)
        return {
          code: 'import * as Native from "react"; import { guardedCreateElement as createElement, guardedCloneElement as cloneElement } from "@nifrajs/web-react/server-components/guard"; export { Children, Fragment, Profiler, StrictMode, Suspense, __SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, cache, cacheSignal, captureOwnerStack, createRef, forwardRef, isValidElement, lazy, memo, use, useCallback, useDebugValue, useId, useMemo, version } from "react"; export { createElement, cloneElement }; export default { ...Native, createElement, cloneElement };',
          map: null,
        }
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The compiler inspects trusted AST/package metadata and its own populated stub map; application data never supplies these values.
      if (stubs.has(id)) return { code: stubs.get(id) as string, map: null }
      const path = bare(id)
      if (id.endsWith(`?${nativeQuery}`)) return { code: readFileSync(path, "utf8"), map: null }
      if (!/\.[cm]?[jt]sx?$/.test(path) || !existsSync(path)) return null
      const source = readFileSync(path, "utf8")
      const ast = sourceFile(source, path)
      if (directive(ast, "use server"))
        throw new Error(
          `[nifra/components] Native use-server actions in ${path} are unsupported; use a validated serverFn in a *.fn.ts module`,
        )
      if (
        this.environment.name === "rsc" &&
        options.adapter === "react" &&
        directive(ast, "use client")
      ) {
        nativeReferences.add(path)
        return { code: nativeFacade(source, path), map: null }
      }
      return null
    },
    transform(source, id) {
      if (id.includes(nativeQuery) || internal.has(bare(id))) return null
      const path = bare(id)
      let code = source
      if (componentFile.test(path)) {
        code = compileComponentModule(source, path, options.root, this.environment.name).code
        componentModules.add(path)
      }
      if (islandFile.test(path))
        code = compileComponentModule(
          source,
          path,
          options.root,
          this.environment.name,
          "island",
        ).code
      if (this.environment.name === "rsc" && options.adapter === "react")
        code = guardCreateElementCalls(code, path)
      return code === source ? null : { code, map: null }
    },
  }
}
