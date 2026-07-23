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
