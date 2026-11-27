/**
 * Memory-leak assertions for `bun test`. Two checks, both free of wall-clock waits:
 *
 *  - {@link isReleased}: `WeakRef`s to objects the test dropped must clear once the engine runs a
 *    full GC. Pins "this object is not retained by X", so a failure names the owner.
 *  - {@link heapGrowth}: heap held after a forced GC, before and after N iterations of a code path.
 *    Catches what no single object shows - an unbounded Map, a listener that never detaches.
 *
 * Both need a forced GC: `Bun.gc(true)` on Bun, `globalThis.gc` where the runtime was started with
 * `--expose-gc`. Without either, the checks throw rather than pass vacuously.
 */

type Gc = (full?: boolean) => void

function findGc(): Gc | undefined {
  const bun: { gc?: Gc } | undefined = Reflect.get(globalThis, "Bun")
  if (typeof bun?.gc === "function") return (full) => bun.gc?.(full ?? true)
  const exposed: Gc | undefined = Reflect.get(globalThis, "gc")
  return typeof exposed === "function" ? exposed : undefined
}

/** Run a full, synchronous collection. Throws when the runtime exposes none. */
export function forceGc(): void {
  const gc = findGc()
  if (gc === undefined) {
    throw new Error(
      "leak checks need a forced GC: run under Bun, or start the runtime with --expose-gc",
    )
  }
  gc(true)
}

// A WeakRef's target stays alive until the current job ends, so a collection can only clear it after
// the test has yielded to the event loop. A macrotask yield also lets pending finalizers and stream
// teardown run. This is a turn of the loop, not a sleep.
const yieldTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Rounds of (GC, yield) before the remaining objects count as retained. Bounded by count, never by time. */
const DEFAULT_ATTEMPTS = 10
const DEFAULT_SAMPLES = 8

export interface ReleaseOptions {
  /** Independent objects built and dropped. Default 8. */
  readonly samples?: number
  /** Collected objects needed to pass. Default half of `samples`, rounded up. */
  readonly minCollected?: number
  readonly attempts?: number
}

/**
 * True when objects that `make` builds and the test drops are collected. `make` builds one, hands
 * back a `WeakRef` to it, and keeps no local of it: build it in a function that returns, so the
 * target is not held by the calling test's own frame.
 *
 *   const make = async () => { const ctx = {}; await cache.for(ctx).get("k"); return new WeakRef(ctx) }
 *   expect(await isReleased(make)).toBe(true)
 *
 * Several objects are built because the engine scans the stack conservatively, so a dropped object
 * can occasionally survive for a reason that is not the code under test (about 1 in 20 here, and it
 * stays held for the rest of the test). A real leak holds every sample, so the check passes only when
 * at least `minCollected` are collected. A leak that holds a minority of samples is the job of
 * {@link heapGrowth}.
 */
export async function isReleased(
  make: () => WeakRef<object> | Promise<WeakRef<object>>,
  options: ReleaseOptions = {},
): Promise<boolean> {
  const samples = options.samples ?? DEFAULT_SAMPLES
  const needed = options.minCollected ?? Math.ceil(samples / 2)
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS
  if (!Number.isInteger(samples) || samples < 1 || needed < 1 || needed > samples) {
    throw new RangeError("isReleased: need 1 <= minCollected <= samples")
  }
  const refs: WeakRef<object>[] = []
  for (let i = 0; i < samples; i++) refs.push(await make())
  for (let i = 0; i < attempts; i++) {
    await yieldTurn()
    forceGc()
    let collected = 0
    for (const ref of refs) if (ref.deref() === undefined) collected++
    if (collected === samples) return true
    if (i === attempts - 1) return collected >= needed
  }
  return false
}

/** Heap bytes held after a full GC and a turn of the loop. */
export async function settledHeapBytes(): Promise<number> {
  await yieldTurn()
  forceGc()
  await yieldTurn()
  forceGc()
  return process.memoryUsage().heapUsed
}

export interface GrowthOptions {
  /** Iterations run before the baseline, so lazy caches and JIT state are not counted. Default 500. */
  readonly warmup?: number
  /** Iterations measured. Default 5000. */
  readonly iterations?: number
}

export interface GrowthResult {
  readonly iterations: number
  /** Heap held after the run minus heap held before it. May be negative. */
  readonly bytes: number
  readonly bytesPerIteration: number
}

/**
 * Heap retained per iteration of `run`. Iterations run in sequence so a leak of even a few dozen
 * bytes each stands clear of the allocator's noise; assert against a cap well under the leak you
 * fear, e.g. `expect(result.bytesPerIteration).toBeLessThan(64)`.
 */
export async function heapGrowth(
  run: (iteration: number) => void | Promise<void>,
  options: GrowthOptions = {},
): Promise<GrowthResult> {
  const warmup = options.warmup ?? 500
  const iterations = options.iterations ?? 5000
  for (let i = 0; i < warmup; i++) await run(i)
  const before = await settledHeapBytes()
  for (let i = 0; i < iterations; i++) await run(warmup + i)
  const after = await settledHeapBytes()
  const bytes = after - before
  return { iterations, bytes, bytesPerIteration: bytes / iterations }
}
