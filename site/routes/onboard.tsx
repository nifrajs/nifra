import { useState } from "react"
import { pageMeta } from "../meta"

export const meta = pageMeta(
  "Nifra — AI Agent Onboarding",
  "Generate customized rules and instructions for Cursor, Claude Code, and other AI coding agents in your Nifra workspace.",
)

export default function Onboard() {
  const [adapter, setAdapter] = useState("react")
  const [env, setEnv] = useState("bun")
  const [db, setDb] = useState("drizzle")
  const [copied, setCopied] = useState(false)

  const promptBlock = `You are a Nifra full-stack agent. Follow these constraints:
1. Tech Stack: Nifra (Bun-native TS framework), Adapter: @nifrajs/web-${adapter}, Env: ${env === "workers" ? "Cloudflare Workers/Pages" : env}, Database: ${db}.
2. Use the end-to-end typed client (\`client<typeof app>("")\`) to fetch API endpoints. Never use raw fetch() for internal APIs.
3. Validate boundaries using \`t.object({ ... })\` (Standard Schema) in your server routes.
4. Keep all server-only code (DB, secrets, node modules) inside \`*.server.ts\` files, or mark with \`import "@nifrajs/web/server-only"\`. Never top-level import them in route page components.
5. Run \`nifra check\` and typecheck after completing edits to verify contract alignment. Do not skip checks.`

  const handleCopy = () => {
    navigator.clipboard.writeText(promptBlock)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      className="onboard-container"
      style={{ maxWidth: "1000px", margin: "40px auto", padding: "0 20px" }}
    >
      <header style={{ marginBottom: "32px" }}>
        <span
          className="kicker"
          style={{
            color: "var(--green-2)",
            fontSize: "12px",
            textTransform: "uppercase",
            fontWeight: "700",
            letterSpacing: "0.05em",
          }}
        >
          Onboarding
        </span>
        <h1 style={{ fontSize: "32px", marginTop: "8px", fontWeight: "800" }}>
          Configure Nifra AI Agent
        </h1>
        <p style={{ color: "var(--muted)", fontSize: "16px", marginTop: "12px" }}>
          Generate highly optimized `.cursorrules` or system prompt blocks tailored to your
          project's adapters and environment.
        </p>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: "32px" }}>
        {/* Selection Column */}
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          <div>
            <h3
              style={{
                fontSize: "14px",
                color: "var(--muted)",
                textTransform: "uppercase",
                marginBottom: "12px",
                letterSpacing: "0.02em",
              }}
            >
              1. UI Adapter
            </h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
              {["react", "solid", "vue", "svelte"].map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAdapter(a)}
                  style={{
                    padding: "12px",
                    borderRadius: "var(--radius)",
                    background: adapter === a ? "rgba(16, 185, 129, 0.08)" : "var(--panel)",
                    border: adapter === a ? "2px solid var(--green)" : "1px solid var(--line-2)",
                    color: adapter === a ? "var(--green-2)" : "var(--fg)",
                    fontWeight: "600",
                    cursor: "pointer",
                    textTransform: "capitalize",
                  }}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>

          <div>
            <h3
              style={{
                fontSize: "14px",
                color: "var(--muted)",
                textTransform: "uppercase",
                marginBottom: "12px",
                letterSpacing: "0.02em",
              }}
            >
              2. Runtime Environment
            </h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
              {[
                { id: "bun", label: "Bun" },
                { id: "node", label: "Node.js" },
                { id: "deno", label: "Deno" },
                { id: "workers", label: "Cloudflare Workers" },
              ].map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => setEnv(e.id)}
                  style={{
                    padding: "12px",
                    borderRadius: "var(--radius)",
                    background: env === e.id ? "rgba(16, 185, 129, 0.08)" : "var(--panel)",
                    border: env === e.id ? "2px solid var(--green)" : "1px solid var(--line-2)",
                    color: env === e.id ? "var(--green-2)" : "var(--fg)",
                    fontWeight: "600",
                    cursor: "pointer",
                  }}
                >
                  {e.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <h3
              style={{
                fontSize: "14px",
                color: "var(--muted)",
                textTransform: "uppercase",
                marginBottom: "12px",
                letterSpacing: "0.02em",
              }}
            >
              3. Data Layer
            </h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
              {[
                { id: "drizzle", label: "Drizzle + SQLite" },
                { id: "d1", label: "Cloudflare D1" },
                { id: "postgres", label: "PostgreSQL" },
                { id: "none", label: "None / In-Memory" },
              ].map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setDb(d.id)}
                  style={{
                    padding: "12px",
                    borderRadius: "var(--radius)",
                    background: db === d.id ? "rgba(16, 185, 129, 0.08)" : "var(--panel)",
                    border: db === d.id ? "2px solid var(--green)" : "1px solid var(--line-2)",
                    color: db === d.id ? "var(--green-2)" : "var(--fg)",
                    fontWeight: "600",
                    cursor: "pointer",
                  }}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Output Column */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-lg)",
            background: "var(--panel)",
            boxShadow: "var(--shadow)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "12px 16px",
              borderBottom: "1px solid var(--line-2)",
              background: "var(--surface)",
            }}
          >
            <span
              style={{
                fontSize: "11px",
                fontFamily: "JetBrains Mono, monospace",
                fontWeight: "700",
                color: "var(--muted)",
              }}
            >
              .cursorrules
            </span>
            <button
              type="button"
              onClick={handleCopy}
              className="button primary"
              style={{
                minHeight: "30px",
                padding: "0 12px",
                fontSize: "12px",
                background: copied ? "var(--green-2)" : "var(--green)",
              }}
            >
              {copied ? "Copied! ✓" : "Copy Rules"}
            </button>
          </div>
          <pre
            style={{
              flex: 1,
              margin: 0,
              padding: "16px",
              fontSize: "12.5px",
              fontFamily: "JetBrains Mono, monospace",
              lineHeight: "1.6",
              color: "var(--fg)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              overflowY: "auto",
              background: "var(--panel)",
            }}
          >
            {promptBlock}
          </pre>
        </div>
      </div>
    </div>
  )
}
