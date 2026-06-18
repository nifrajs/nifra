import type { Config } from "@react-router/dev/config"

// SSR on (server-render per request) — the shared dynamic workload, not prerendered.
export default { ssr: true } satisfies Config
