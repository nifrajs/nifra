# Agent tool and workflow registry proposal

The optional registry is intentionally a local seam in preview releases:

1. An extension declares a stable tool or workflow id and a bounded capability list.
2. The host validates and stages the extension graph.
3. Authenticated clients query `workflow.list`, `ui.snapshot`, and session capabilities.
4. Invocation stays in the local host, under the host's approval, workspace, and resource limits.

A future public registry can distribute signed metadata and versioned manifests. It must not move
credentials, tenant state, pricing, prompt IP, or operated execution into the public package.
