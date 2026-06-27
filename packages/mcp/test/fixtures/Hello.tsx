// Fixture for the reactWidget bundling test. Uses createElement (no JSX) and is excluded from the root
// typecheck program — it exists only to be bundled by Bun.build at test time.
import { createElement } from "react"

export default function Hello({ name = "world" }: { name?: string }) {
  return createElement("p", { id: "greeting" }, `Hello ${name}`)
}
