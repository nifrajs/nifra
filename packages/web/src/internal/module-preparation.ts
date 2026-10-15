interface ModuleEntry<T extends object> {
  readonly load: () => Promise<T>
}

/** Production imports are immutable; failed imports remain retryable. No loader data is cached. */
export function prepareModules(
  enabled: boolean,
): <T extends object>(entry: ModuleEntry<T>) => T | Promise<T> {
  const modules = new WeakMap<object, object | Promise<object>>()
  return <T extends object>(entry: ModuleEntry<T>): T | Promise<T> => {
    if (!enabled) return entry.load()
    const known = modules.get(entry)
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Only this entry.load populates its slot, so the cached value retains that entry's module type.
    if (known !== undefined) return known as T | Promise<T>
    const pending = Promise.resolve()
      .then(() => entry.load())
      .then(
        (module) => {
          modules.set(entry, module)
          return module
        },
        (error) => {
          modules.delete(entry)
          throw error
        },
      )
    modules.set(entry, pending)
    return pending
  }
}
