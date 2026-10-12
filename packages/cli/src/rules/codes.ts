/** Built-in diagnostic code registry. Codes are append-only and reserved by the NF- prefix. */

export const RULE_CODES = Object.freeze({
  "NF-C001": "TypeScript contract check",
  "NF-C002": "Typed client check",
  "NF-C003": "Untyped client check",
  "NF-C004": "Server-only import check",
  "NF-C005": "Removed import check",
  "NF-C006": "Interpolated SQL check",
  "NF-C007": "Raw response route advisory",
  "NF-C008": "Undeclared dependency check",
  "NF-C009": "Duplicate install check",
  "NF-C010": "Stale workspace build check",
  "NF-C011": "Build pipeline check",
  "NF-C012": "Server manifest drift check",
  "NF-C013": "Trust manifest drift check",
  "NF-C014": "Capability assurance check",
  "NF-C015": "Assurance configuration check",
  "NF-C016": "Check configuration check",
  "NF-C017": "Rule pack validation",
  "NF-C018": "Reserved client segment check",
  "NF-C019": "Duplicate route registration check",
  "NF-C024": "Overlapping route registration check",
  "NF-C025": "Route overlap analysis budget check",
  "NF-C026": "Route param modifier check",
  "NF-C027": "Page route under the backend mount",
  "NF-C028": "Zone import check",
  "NF-C029": "Private environment read in browser code",
  "NF-C030": "Route data without an output schema",
  "NF-C031": "Sensitive field in an output schema",
  "NF-C032": "Credential in browser code",
  "NF-C033": "Generated output schema out of date",
  "NF-C034": "Root status page wraps the root layout itself",
  "NF-C035": "Backend not served over HTTP",
  "NF-C036": "Route path the static scan cannot read",
  "NF-C037": "API-only declaration over a web app",
  "NF-C038": "Retired root layout file",
  "NF-C039": "Implemented contract operation the backend does not serve",
  "NF-C040": "Layout meta reads data its layout never loads",
  "NF-C041": "Server-only export in a route frontend file",
  "NF-C020": "Island enhancer cleanup check",
  "NF-C021": "nano binding cleanup check",
  "NF-C022": "nano bindList key check",
  "NF-C023": "nano computed deps check",
  "NF-D001": "Doctor check",
  "NF-D002": "Mixed nifra versions",
  "NF-A001": "Assurance bundle check",
  "NF-H001": "Hydration mismatch",
  "NF-H002": "Duplicate framework runtime",
  "NF-H003": "Stale client build",
  "NF-H004": "Hydration interaction",
  "NF-K001": "Contract snapshot drift",
  "NF-S001": "Fail-open gate",
  "NF-S002": "Non-constant-time secret comparison",
  "NF-S003": "Sensitive value in log call",
  "NF-S004": "CORS origin predicate ignores the origin",
  "NF-S005": "External redirect opt-out",
  "NF-S006": "Security escape hatch enabled",
  "NF-S007": "Secure cookie without a __Host-/__Secure- prefix",
  "NF-S008": "Authenticated route validates input before authentication",
} as const)

/** Codes that no longer fire but remain reserved forever. */
export const RETIRED_CODES: ReadonlySet<string> = new Set()

export type BuiltInCode = keyof typeof RULE_CODES

export function isBuiltInCode(code: string): code is BuiltInCode {
  return code in RULE_CODES || RETIRED_CODES.has(code)
}

export function assertUniqueRuleCodes(): void {
  const codes = Object.keys(RULE_CODES)
  if (new Set(codes).size !== codes.length)
    throw new Error("diagnostic code registry contains duplicates")
  for (const code of codes) {
    if (!/^NF-[A-Z]\d{3}$/.test(code)) throw new Error(`invalid built-in diagnostic code: ${code}`)
  }
}

assertUniqueRuleCodes()
