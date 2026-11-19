export const VERIFICATION_GATES = [
  { level: 0, kind: "typecheck", name: "typed contract" },
  { level: 1, kind: "assurance", name: "route assurance" },
  { level: 2, kind: "capability", name: "capability lockfile" },
  { level: 3, kind: "manifest", name: "route manifest" },
  { level: 4, kind: "invariants", name: "invariant-tested" },
] as const

export type VerificationGate = (typeof VERIFICATION_GATES)[number]
