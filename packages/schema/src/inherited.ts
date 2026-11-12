// TypeBox reads an object's property as `value[key]` (and a required `any`/`unknown` one as
// `key in value`), on the compiled checker, the `Value` checker, `Errors` and `Convert` alike. Both
// walk the prototype chain, so a key named after an `Object.prototype` member (`constructor`,
// `toString`, `valueOf`, ...) is never absent from a plain object: `{}` fails an optional
// `constructor: t.array(...)` against the inherited `Object` function, and `Convert` writes that
// function back onto the input as an own key. A schema that names such a key validates an own view
// of the input instead, where a plain object carries nothing it did not set itself.

const isInheritedMember = (key: string): boolean => Object.hasOwn(Object.prototype, key)

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object"

/** Whether `node` declares a property that every plain object inherits from `Object.prototype`. */
export function namesInheritedMember(node: unknown): boolean {
  if (!isObject(node)) return false
  if (Array.isArray(node)) return node.some(namesInheritedMember)
  for (const key of Object.getOwnPropertyNames(node)) {
    const value = node[key]
    if (
      key === "properties" &&
      isObject(value) &&
      Object.getOwnPropertyNames(value).some(isInheritedMember)
    )
      return true
    if (namesInheritedMember(value)) return true
  }
  return false
}

function reachesPlainObject(value: unknown, seen: Set<object>): boolean {
  if (!isObject(value) || seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (reachesPlainObject(value[i], seen)) return true
    return false
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== null) return proto === Object.prototype
  for (const key of Object.getOwnPropertyNames(value)) {
    if (reachesPlainObject(value[key], seen)) return true
  }
  return false
}

function copyOwn(value: unknown, copies: Map<object, unknown>): unknown {
  if (!isObject(value)) return value
  const done = copies.get(value)
  if (done !== undefined) return done
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length)
    copies.set(value, out)
    // A hole stays a hole: TypeBox's `every` skips it.
    for (let i = 0; i < value.length; i++) if (i in value) out[i] = copyOwn(value[i], copies)
    return out
  }
  // A class instance, Date or byte array keeps its prototype: its checks read through it.
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const out: Record<string, unknown> = Object.create(null)
  copies.set(value, out)
  // Own enumerable string keys, what JSON carries. Assignment, not `defineProperty`, measured about
  // half the cost per object.
  for (const key of Object.keys(value)) out[key] = copyOwn(value[key], copies)
  return out
}

/**
 * `value` with each plain object copied onto a null prototype, so a member `Object.prototype`
 * supplies reads as absent. Returned as it is when it reaches no object with that prototype (core's
 * own query, header and cookie objects), so a coercing check still converts it in place.
 */
export function ownView(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  const reaches =
    Object.getPrototypeOf(value) === Object.prototype || reachesPlainObject(value, new Set())
  return reaches ? copyOwn(value, new Map()) : value
}
