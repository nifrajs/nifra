/**
 * A bundler-neutral view of a client build, for the guards that must run on every pipeline.
 *
 * nifra's two client-leak guards - server-only code reaching the browser, and `node:` builtins in
 * client code - are the reason a pipeline choice is safe. They are security guards, not lints: one
 * stops secrets and database access shipping to a browser. Today both read Bun's metafile directly,
 * so a second production pipeline would either arrive without them or need them hastily ported, and
 * "mostly ported" is the wrong outcome for a guard of that kind.
 *
 * This is the seam that prevents that. It is introduced while Bun is still the ONLY producer, so the
 * adapter can be verified against the existing behaviour rather than written under pressure beside a
 * new bundler. Adding Rollup later becomes one more `from…` function rather than a second copy of the
 * detection logic.
 *
 * Deliberately minimal - exactly what the guards read, nothing more:
 *   - which modules exist and what each imports (to walk the import chain to a sink)
 *   - which output chunk each module landed in (to name the chunk a leak reached)
 */

/** One import edge, as the bundler recorded it. */
export interface GraphImport {
  /** The resolved path, when the bundler resolved it. */
  readonly path?: string
  /** The specifier as written in source - the only form that survives an unresolved import. */
  readonly original?: string
}

export interface GraphModule {
  readonly imports: readonly GraphImport[]
}

export interface GraphChunk {
  /** Source module this chunk is the entry for, if it is one. */
  readonly entryPoint?: string
  /** Module ids that landed in this chunk. */
  readonly modules: readonly string[]
}

/** What a client build looks like to the guards, whichever bundler produced it. */
export interface ClientModuleGraph {
  /** Module id → its imports. Ids are bundler-native (Bun graph keys, Rollup module ids). */
  readonly modules: Readonly<Record<string, GraphModule>>
  /** Output path → what it contains. */
  readonly chunks: Readonly<Record<string, GraphChunk>>
}

/** The slice of Bun's metafile this seam consumes. Not yet in `@types/bun`; shape per the docs. */
export interface BunMetafileLike {
  readonly inputs?: Readonly<
    Record<string, { readonly imports?: ReadonlyArray<{ path?: string; original?: string }> }>
  >
  readonly outputs?: Readonly<
    Record<
      string,
      { readonly entryPoint?: string; readonly inputs?: Readonly<Record<string, unknown>> }
    >
  >
}

/**
 * Adapt a `Bun.build` metafile to the neutral graph.
 *
 * A total function: an absent or partial metafile yields an empty graph rather than throwing, because
 * a guard that crashes on an unexpected build shape fails the build for the wrong reason. An empty
 * graph reports no findings, which matches the existing behaviour when the metafile is missing.
 */
export function fromBunMetafile(meta: BunMetafileLike | undefined): ClientModuleGraph {
  const modules: Record<string, GraphModule> = {}
  for (const [id, input] of Object.entries(meta?.inputs ?? {})) {
    modules[id] = { imports: input.imports ?? [] }
  }
  const chunks: Record<string, GraphChunk> = {}
  for (const [path, output] of Object.entries(meta?.outputs ?? {})) {
    chunks[path] = {
      ...(output.entryPoint !== undefined ? { entryPoint: output.entryPoint } : {}),
      modules: Object.keys(output.inputs ?? {}),
    }
  }
  return { modules, chunks }
}

/**
 * The slice of a Rollup/Vite output bundle this seam consumes. `OutputBundle` is
 * `Record<fileName, OutputChunk | OutputAsset>`; only chunks carry a module graph. Typed structurally
 * (no `rollup`/`vite` type dependency) — the fields are stable Rollup output API.
 */
export interface RollupChunkLike {
  /** `"chunk"` for JS output, `"asset"` for CSS/static — assets have no module graph. */
  readonly type?: string
  /** The entry module id this chunk was built for, if it is an entry. Rollup's `facadeModuleId`. */
  readonly facadeModuleId?: string | null
  /** Every module id that landed in this chunk. Rollup's `moduleIds`. */
  readonly moduleIds?: readonly string[]
}
export type RollupBundleLike = Readonly<Record<string, RollupChunkLike>>

/**
 * Adapt a Rollup/Vite output bundle to the neutral graph — the second producer the seam was built for.
 *
 * The bundle records which modules landed in which chunk (`moduleIds`) but NOT each module's import
 * edges, so those come from `importsOf`, which the caller backs with `this.getModuleInfo(id).importedIds`
 * inside a plugin hook (a test backs it with a plain map). Edges carry only the RESOLVED id — Rollup does
 * not keep the as-written specifier per edge — so `path` is set and `original` is left undefined. Both
 * guards read the resolved `path` as their fallback (a `node:` prefix, the `server-only` basename), so
 * detection is unaffected; only the human-readable chain shows resolved paths instead of as-written ones.
 *
 * Total, like {@link fromBunMetafile}: an empty bundle yields an empty graph (no findings), never a throw
 * that would fail a build for the wrong reason.
 */
export function fromRollupBundle(
  bundle: RollupBundleLike,
  importsOf: (moduleId: string) => readonly string[],
): ClientModuleGraph {
  const modules: Record<string, GraphModule> = {}
  const chunks: Record<string, GraphChunk> = {}
  for (const [fileName, output] of Object.entries(bundle)) {
    // Assets (CSS, copied files) have no module graph; `type` is absent only on hand-built test inputs,
    // which are always chunks, so treat "not explicitly an asset" as a chunk.
    if (output.type === "asset") continue
    const moduleIds = output.moduleIds ?? []
    // Start from the real modules; `node:` builtins get appended below.
    const chunkModules: string[] = [...moduleIds]
    for (const id of moduleIds) {
      const imports = importsOf(id).map((path) => ({ path }))
      if (modules[id] === undefined) modules[id] = { imports }
      // The guards locate a leak by finding the builtin IN a chunk's module list - Bun BUNDLES the `node:`
      // polyfill, so the builtin appears there as an input. Rollup EXTERNALIZES `node:`, so it never lands
      // in `moduleIds` and the guard would see nothing. Synthesize the Bun shape: register each imported
      // builtin as a member of THIS chunk (where the leak is) and as a leaf module, so the neutral graph
      // is identical whichever bundler produced it. Only `node:` needs this; a server-only-marked module
      // is a real user module and is already a chunk member.
      for (const im of imports) {
        if (!im.path.startsWith("node:")) continue
        if (!chunkModules.includes(im.path)) chunkModules.push(im.path)
        if (modules[im.path] === undefined) modules[im.path] = { imports: [] }
      }
    }
    chunks[fileName] = {
      // `facadeModuleId` is null for a shared/common chunk (no single entry) — omit it then, matching
      // how a non-entry Bun output omits `entryPoint`, so the guards' entry set stays the real entries.
      ...(output.facadeModuleId ? { entryPoint: output.facadeModuleId } : {}),
      modules: chunkModules,
    }
  }
  return { modules, chunks }
}
