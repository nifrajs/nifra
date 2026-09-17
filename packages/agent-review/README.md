# @nifrajs/agent-review

`@nifrajs/agent-review` is a small, provider-neutral contract for bounded review results. It is a
leaf package: it does not run checks, read a repository, invoke fixes, provide a CLI, or persist
review data.

```ts
import { composeReviewReport, parseReviewReport } from "@nifrajs/agent-review"

const report = await composeReviewReport({
  strict: false,
  scope: {
    kind: "project",
    state: "valid",
    changedPaths: [],
    pathDigest: "a".repeat(64),
    outOfScopeCount: 0,
  },
  checks: [],
  findings: [],
})

const verified = await parseReviewReport(JSON.stringify(report))
```

The parser accepts a JSON string or an unknown value and fails closed. It rejects unknown keys and
content-bearing keys such as `message`, `prompt`, `output`, `payload`, `body`, and `secret` at any
depth. Findings carry only stable codes, structural categories, safe locations, and opaque
evidence references; they do not carry diagnostic messages, source text, requests, responses, or
model content.

Reports are limited to 256 KiB, depth 8, 32 keys per object, 1,024 array items, 512-byte paths,
256-byte Git references, and bounded identifiers. Paths are project-relative POSIX paths. Parsed
reports are deeply frozen. Report status, blocking count, and success are derived and verified;
callers cannot make an invalid report pass by changing those fields.

Canonical report digests use lowercase Web Crypto SHA-256. Check duration is display-only and is
excluded from the digest, so equivalent structure has the same identity across runtimes and timing.
The package uses no runtime dependencies, filesystem access, environment reads, provider SDKs, or
Nifra package imports. It relies on `globalThis.crypto.subtle` and `TextEncoder`, which are available
in Bun, modern Node, Deno, Workers, and browsers.

The composer accepts only the typed structural inputs already produced by a trusted collector. It
sorts and copies them, derives the outcome, signs the canonical report, and runs the same parser
boundary before returning it. Repository collectors, CLI/MCP projections, SARIF, and safe fix
recipes belong in higher-level packages.

For coding agents, see [`LLM.md`](./LLM.md). The full machine-readable corpus is [`../../llms-full.txt`](../../llms-full.txt).
