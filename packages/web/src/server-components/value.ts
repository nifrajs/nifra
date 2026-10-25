import { canonicalJson } from "@nifrajs/core/canonical-json"
import { ServerComponentError } from "./error.ts"
import type { ComponentValue } from "./types.ts"

/** Property order does not identify a resource; callers supply already-validated DTO inputs. */
export const componentInputKey: (value: ComponentValue) => string = canonicalJson

const encoder = new TextEncoder()
const forbidden = new Set(["__proto__", "prototype", "constructor"])

export function componentValue(value: unknown, maxBytes: number = 65536): ComponentValue {
  const seen = new Set<object>()
  let nodes = 0
  let bytes = 0
  const charge = (text: string): void => {
    bytes += encoder.encode(text).byteLength
    if (bytes > maxBytes) throw new ServerComponentError("component_limit", 413)
  }
  const visit = (item: unknown, depth: number): ComponentValue => {
    if (++nodes > 8192 || depth > 16) throw new ServerComponentError("component_limit", 413)
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      charge(JSON.stringify(item))
      return item
    }
    if (typeof item !== "object" || item === null || seen.has(item))
      throw new ServerComponentError("component_contract")
    const array = Array.isArray(item)
    const prototype = Object.getPrototypeOf(item)
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    ) {
      throw new ServerComponentError("component_contract")
    }
    // Reject custom serializers without invoking them, including inherited serializers.
    if ("toJSON" in item || Object.getOwnPropertySymbols(item).length > 0)
      throw new ServerComponentError("component_contract")
    const descriptors = Object.getOwnPropertyDescriptors(item)
    const names = Object.keys(descriptors)
    if (array && (item.length > 8192 || names.length !== item.length + 1))
      throw new ServerComponentError("component_contract")
    const result: ComponentValue[] | Record<string, ComponentValue> = array
      ? []
      : Object.create(null)
    seen.add(item)
    charge(array ? "[]" : "{}")
    let count = 0
    for (const name of names) {
      if (array && name === "length") continue
      const property = descriptors[name]!
      if (
        forbidden.has(name) ||
        !property.enumerable ||
        !Object.hasOwn(property, "value") ||
        (array && (!/^(0|[1-9][0-9]*)$/.test(name) || Number(name) >= item.length))
      ) {
        throw new ServerComponentError("component_contract")
      }
      charge((count++ === 0 ? "" : ",") + (array ? "" : `${JSON.stringify(name)}:`))
      Object.defineProperty(result, name, {
        value: visit(property.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    seen.delete(item)
    return result
  }
  return visit(value, 0)
}
