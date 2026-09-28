import type { Diagnostic } from "../diagnostics.ts"
import {
  loadProjectTypeScript,
  type TypeScriptApi,
  type TypeScriptSession,
  unsupportedTypeScriptDiagnostic,
} from "../internal/typescript-import.ts"
import type { RuleContext } from "./index.ts"

interface RuleTypeScriptLoad {
  readonly compiler: TypeScriptApi | undefined
  readonly session: TypeScriptSession | undefined
  readonly diagnostics: readonly Diagnostic[] | undefined
}

interface SessionCacheEntry {
  readonly pending: ReturnType<typeof loadProjectTypeScript>
  leases: number
}

const sessionCache = new WeakMap<RuleContext["sources"], SessionCacheEntry>()

function cachedLoad(ctx: RuleContext): SessionCacheEntry {
  const cached = sessionCache.get(ctx.sources)
  if (cached !== undefined) return cached
  const entry: SessionCacheEntry = {
    pending: loadProjectTypeScript(ctx.root, undefined, ctx.sources),
    leases: 0,
  }
  sessionCache.set(ctx.sources, entry)
  return entry
}

/** Retain a direct rule-registry session until the whole registry run has completed. */
export function retainRuleTypeScript(ctx: RuleContext): void {
  const entry = cachedLoad(ctx)
  entry.leases += 1
}

/** Release a direct rule-registry session and terminate its TypeScript 7 worker when unused. */
export async function releaseRuleTypeScript(ctx: RuleContext): Promise<void> {
  const entry = sessionCache.get(ctx.sources)
  if (entry === undefined) return
  entry.leases = Math.max(0, entry.leases - 1)
  if (entry.leases !== 0) return
  sessionCache.delete(ctx.sources)
  try {
    const loaded = await entry.pending
    await loaded.session?.close()
  } catch {
    // The scanner that consumed the same pending load owns the diagnostic for load failures.
  }
}

/** Keep every AST-backed rule on the same project compiler session. */
export async function loadRuleTypeScript(ctx: RuleContext): Promise<RuleTypeScriptLoad> {
  if (ctx.project.check.unsupportedTypeScriptVersion !== undefined) {
    // The check-wide loader already supplied the single structured failure diagnostic.
    return { compiler: undefined, session: undefined, diagnostics: [] }
  }
  if (ctx.typescriptSession !== undefined) {
    return {
      compiler: ctx.typescriptSession.compiler,
      session: ctx.typescriptSession,
      diagnostics: undefined,
    }
  }
  const loaded = await cachedLoad(ctx).pending
  if (loaded.unsupported !== undefined) {
    return {
      compiler: undefined,
      session: undefined,
      diagnostics: [unsupportedTypeScriptDiagnostic(loaded.unsupported.version)],
    }
  }
  return { compiler: loaded.compiler, session: loaded.session, diagnostics: undefined }
}
