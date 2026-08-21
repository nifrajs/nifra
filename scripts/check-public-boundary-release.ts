if (
  (process.env.PRIVATE_MARKERS ?? "").split(",").some((value) => value.trim().length > 0) === false
) {
  console.error("✗ check-public-boundary: PRIVATE_MARKERS is required for release verification")
  process.exit(1)
}
process.env.RELEASE_MODE = "1"
const { runPublicBoundary } = await import("./check-public-boundary.ts")
const failures = await runPublicBoundary({ release: true })
if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  process.exit(1)
}
console.log("✓ public boundary release: marker configuration present and structural policy passed")
