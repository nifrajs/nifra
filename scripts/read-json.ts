import { readFileSync } from "node:fs"

/** Parse JSON without claiming a shape; callers validate the fields they consume. */
export function parseJson(source: string): unknown {
  return JSON.parse(source)
}

/** Read and parse a JSON file without trusting its declared shape. */
export function readJson(path: string): unknown {
  return parseJson(readFileSync(path, "utf8"))
}

/** JSON objects are records with string keys; arrays and null are excluded. */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Read a JSON file whose top-level value must be an object. */
export function readJsonRecord(path: string): Record<string, unknown> {
  const value = readJson(path)
  if (!isJsonRecord(value)) throw new Error(`${path} must contain a JSON object`)
  return value
}
