const lazyRequestAccessorContexts = new WeakSet<object>()

export function markLoaderContextWithLazyRequestAccessors(context: object): void {
  lazyRequestAccessorContexts.add(context)
}

export function forkLoaderContext<T extends object>(context: T, overrides: Partial<T>): T {
  if (!lazyRequestAccessorContexts.has(context)) return { ...context, ...overrides } as T

  const fork: T = Object.create(Object.getPrototypeOf(context))
  Object.defineProperties(fork, Object.getOwnPropertyDescriptors(context))
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(fork, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    })
  }
  lazyRequestAccessorContexts.add(fork)
  return fork
}
