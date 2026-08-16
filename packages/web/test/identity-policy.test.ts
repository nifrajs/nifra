import { expect, test } from "bun:test"
import { IDENTITY_SENSITIVE_PACKAGES } from "@nifrajs/core/single-copy"
import {
  FRONTEND_DEDUPE_POLICIES,
  isIdentitySensitivePackage,
  viteDedupePackages,
} from "../src/internal/identity-policy.ts"

// The predicate is the one seam parity.ts and the build pipelines share, so it must be exactly core's
// answer - the whole point of deleting the re-declared list.
test("isIdentitySensitivePackage delegates to core's canonical declaration", () => {
  for (const name of ["react", "react-dom", "preact", "solid-js", "svelte", "vue"]) {
    expect(isIdentitySensitivePackage(name)).toBe(true)
  }
  // `@nifrajs/*` is matched by pattern - two copies of core are two `Server` classes.
  expect(isIdentitySensitivePackage("@nifrajs/core")).toBe(true)
  expect(isIdentitySensitivePackage("@nifrajs/web")).toBe(true)
  // Same-prefix decoys must NOT match, or the parity scan would chase unrelated packages.
  expect(isIdentitySensitivePackage("react-router")).toBe(false)
  expect(isIdentitySensitivePackage("preact-iso")).toBe(false)
  expect(isIdentitySensitivePackage("@nifrajscdn/core")).toBe(false)
})

// Every framework the build pipelines name-pin must be one core agrees is identity-sensitive. Core may
// be a SUPERSET (solid/vue select their copy through conditions, so they carry no name-pinning entry),
// but a strategy for a package core does not track would be a silent, unenforceable claim.
test("every dedupe policy targets a core-recognized identity-sensitive package", () => {
  for (const policy of FRONTEND_DEDUPE_POLICIES) {
    expect(isIdentitySensitivePackage(policy.framework)).toBe(true)
    for (const name of policy.viteDedupe) {
      expect(isIdentitySensitivePackage(name)).toBe(true)
    }
  }
})

// Each entry must give a Bun strategy AND a Vite one, so a framework can never be pinned in one client
// bundler but silently dual-loaded in the other - the exact drift (Vite deduped react alone while the
// Bun build also pinned preact + svelte) this table exists to close.
test("every framework carries both a Bun and a Vite strategy, exactly one Bun arm", () => {
  for (const policy of FRONTEND_DEDUPE_POLICIES) {
    const hasSpecs = policy.bunSpecs !== undefined && policy.bunSpecs.length > 0
    const hasPattern = policy.bunPattern !== undefined
    expect(hasSpecs !== hasPattern).toBe(true) // exactly one Bun arm
    expect(policy.viteDedupe.length).toBeGreaterThan(0)
  }
})

test("viteDedupePackages is the flat, de-duplicated union of every viteDedupe list", () => {
  const flat = viteDedupePackages()
  expect(new Set(flat).size).toBe(flat.length) // no repeats
  expect(new Set(flat)).toEqual(
    new Set(FRONTEND_DEDUPE_POLICIES.flatMap((policy) => policy.viteDedupe)),
  )
  // Guards the react-only regression: preact and svelte must be present now.
  expect(flat).toContain("react")
  expect(flat).toContain("react-dom")
  expect(flat).toContain("preact")
  expect(flat).toContain("svelte")
})

// A published truth: the constant is the export the whole toolchain reads. If someone shrinks it, this
// says so, and points at the enforcement + parity paths that would silently narrow with it.
test("core identity set still covers every framework this table pins", () => {
  for (const policy of FRONTEND_DEDUPE_POLICIES) {
    expect(IDENTITY_SENSITIVE_PACKAGES).toContain(policy.framework)
  }
})
