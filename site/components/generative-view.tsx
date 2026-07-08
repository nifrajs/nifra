import type React from "react"

export interface GenerativeViewProps {
  data: unknown
  fallback?: React.ReactNode
}

type Row = Record<string, unknown>

const CARD_STYLE: React.CSSProperties = {
  padding: "12px",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius)",
  background: "var(--panel)",
}

/**
 * **Starter component** — auto-renders arbitrary structured data (e.g. an MCP `.tool()` / agent result) as a
 * table, cards, metric tiles, or a detail list, chosen from an explicit `intent` (or `_meta.ui.intent`) or a
 * shape heuristic. Meant as a drop-in for previewing agent output, **not** a hardened data grid: it uses
 * array-index keys, inline styles keyed to the host's CSS variables (`--fg`, `--panel`, `--line-2`, …), and
 * a fixed shape vocabulary, with no virtualization. Copy and adapt it for production surfaces.
 */
export function GenerativeView({ data, fallback }: GenerativeViewProps) {
  if (!data || typeof data !== "object") {
    return fallback ? fallback : String(data)
  }
  const obj = data as Record<string, unknown>

  // Support SEP-1865 structured results:
  const content = obj.structuredContent ?? obj
  const meta = obj._meta as { readonly ui?: { readonly intent?: unknown } } | undefined
  const intent = String(meta?.ui?.intent ?? obj.intent ?? "auto")

  if (typeof content !== "object" || content === null) {
    return <>{String(content)}</>
  }
  const record = content as Row

  // Simple auto-detection of shape if "auto"
  let resolvedIntent = intent
  if (resolvedIntent === "auto") {
    if (Array.isArray(content)) {
      resolvedIntent = "list"
    } else {
      const keys = Object.keys(record)
      const firstKey = keys[0]
      const firstVal = firstKey !== undefined ? record[firstKey] : undefined
      if (Array.isArray(firstVal)) {
        resolvedIntent = "table"
      } else {
        resolvedIntent = "detail"
      }
    }
  }

  switch (resolvedIntent) {
    case "table": {
      let rows: Row[] = []
      if (Array.isArray(content)) {
        rows = content as Row[]
      } else {
        const arrays = Object.values(record).filter(Array.isArray)
        if (arrays.length > 0) {
          rows = arrays[0] as Row[]
        }
      }

      if (rows.length === 0) return <div>No data available</div>
      const headers = Object.keys(rows[0] ?? {})
      return (
        <div style={{ overflowX: "auto", margin: "10px 0" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--line-2)" }}>
                {headers.map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: "left",
                      padding: "8px",
                      fontWeight: "600",
                      color: "var(--muted)",
                      textTransform: "capitalize",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: generative rows are arbitrary data with no stable id
                <tr key={idx} style={{ borderBottom: "1px solid var(--line-2)" }}>
                  {headers.map((h) => (
                    <td key={h} style={{ padding: "8px", color: "var(--fg)" }}>
                      {typeof row[h] === "object" ? JSON.stringify(row[h]) : String(row[h] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }

    case "cards": {
      let items: Row[] = []
      if (Array.isArray(content)) {
        items = content as Row[]
      } else {
        const arrays = Object.values(record).filter(Array.isArray)
        if (arrays.length > 0) {
          items = arrays[0] as Row[]
        }
      }
      return (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: "12px",
            margin: "10px 0",
          }}
        >
          {items.map((item, idx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: generative cards are arbitrary data with no stable id
            <div key={idx} style={CARD_STYLE}>
              {Object.entries(item ?? {}).map(([k, v]) => (
                <div key={k} style={{ marginBottom: "6px" }}>
                  <div
                    style={{
                      fontSize: "10px",
                      color: "var(--muted)",
                      textTransform: "uppercase",
                      fontWeight: "700",
                    }}
                  >
                    {k}
                  </div>
                  <div style={{ fontSize: "13px", color: "var(--fg)" }}>
                    {typeof v === "object" ? JSON.stringify(v) : String(v ?? "")}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )
    }

    case "metric": {
      const entries = Object.entries(record)
      return (
        <div style={{ display: "flex", gap: "24px", flexWrap: "wrap", margin: "10px 0" }}>
          {entries.map(([k, v]) => (
            <div key={k} style={{ display: "flex", flexDirection: "column" }}>
              <span
                style={{
                  fontSize: "11px",
                  color: "var(--muted)",
                  textTransform: "uppercase",
                  fontWeight: "600",
                }}
              >
                {k}
              </span>
              <span
                style={{
                  fontSize: "32px",
                  fontWeight: "700",
                  color: "var(--green-2)",
                  marginTop: "4px",
                }}
              >
                {typeof v === "object" ? JSON.stringify(v) : String(v ?? "")}
              </span>
            </div>
          ))}
        </div>
      )
    }
    default: {
      return (
        <div style={{ margin: "10px 0", fontSize: "13px" }}>
          {Object.entries(record).map(([k, v]) => (
            <div
              key={k}
              style={{
                display: "flex",
                padding: "8px 0",
                borderBottom: "1px dashed var(--line-2)",
              }}
            >
              <span
                style={{
                  fontWeight: "600",
                  color: "var(--muted)",
                  width: "120px",
                  flexShrink: 0,
                }}
              >
                {k}
              </span>
              <span style={{ color: "var(--fg)", flex: 1 }}>
                {typeof v === "object" ? JSON.stringify(v) : String(v ?? "")}
              </span>
            </div>
          ))}
        </div>
      )
    }
  }
}
