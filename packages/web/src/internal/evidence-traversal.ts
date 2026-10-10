import type { AsyncLocalStorage } from "node:async_hooks"
import type { BackendEvidenceProvider } from "@nifrajs/core/mount"

/** The providers composing the current evidence read, outermost first. */
export type EvidenceAncestry = ReadonlySet<BackendEvidenceProvider>

// Looked up, never imported: a self-contained Worker bundle hoists an import of node:async_hooks,
// and a Worker on an older compatibility date without nodejs_compat then fails to start. Created
// on the first evidence read, so serving an app never constructs an AsyncLocalStorage.
let storage: AsyncLocalStorage<EvidenceAncestry> | undefined

// Without async context, a cycle through a provider that drops the chain reads like concurrent
// reads. A nested read never settles before its children, so such a cycle piles up in-flight reads
// of one provider without bound, while real concurrency stays at a handful (llms.txt memoizes).
const MAX_UNTRACKED_READS = 64
const untrackedReads = new WeakMap<BackendEvidenceProvider, number>()

function ancestryStorage(): AsyncLocalStorage<EvidenceAncestry> | undefined {
  const hooks = globalThis.process?.getBuiltinModule?.("node:async_hooks")
  if (hooks?.AsyncLocalStorage === undefined) return undefined
  storage ??= new hooks.AsyncLocalStorage()
  return storage
}

/**
 * Run `read` with `provider` joined to the providers already composing this read, refusing a
 * provider that is its own ancestor. The async context follows a cycle through any provider; the
 * `passed` chain, which framework providers hand to the providers they compose, is the only record
 * on a runtime without AsyncLocalStorage, where a cap on in-flight reads of one provider stops a
 * cycle the chain cannot see.
 */
export async function traverseEvidence<T>(
  provider: BackendEvidenceProvider,
  passed: unknown,
  read: (ancestry: EvidenceAncestry) => Promise<T>,
): Promise<T> {
  const context = ancestryStorage()
  const parents = new Set(context?.getStore())
  if (passed instanceof Set) for (const parent of passed) parents.add(parent)
  if (parents.has(provider)) {
    throw new Error("[nifra/web] cyclic composed assurance evidence mount")
  }
  const ancestry: EvidenceAncestry = parents.add(provider)
  if (context !== undefined) return context.run(ancestry, read, ancestry)
  const reads = untrackedReads.get(provider) ?? 0
  if (reads >= MAX_UNTRACKED_READS) {
    throw new Error(
      `[nifra/web] cyclic composed assurance evidence mount: more than ${MAX_UNTRACKED_READS} reads of one app in flight. This runtime has no AsyncLocalStorage (on Cloudflare, enable nodejs_compat), so a cycle through a custom provider is caught only by this cap.`,
    )
  }
  untrackedReads.set(provider, reads + 1)
  try {
    return await read(ancestry)
  } finally {
    untrackedReads.set(provider, (untrackedReads.get(provider) ?? 1) - 1)
  }
}
