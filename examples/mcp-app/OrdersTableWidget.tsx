/**
 * The orders widget authored as a React component (MCP Apps via `@nifrajs/mcp/react`). It receives the
 * tool's `structuredContent` as props; `reactWidget` bundles it for the browser and re-renders it on every
 * push over the bridge. This file is referenced by PATH from backend.ts (never imported there), so the
 * backend stays JSX-free and the root typechecker ignores this component.
 */
import { useMemo, useState } from "react"

interface Order {
  id: number
  customer: string
  total: number
}

export default function OrdersTable({ orders = [] }: { orders?: Order[] }) {
  const [query, setQuery] = useState("")
  const shown = useMemo(
    () => orders.filter((o) => o.customer.toLowerCase().includes(query.toLowerCase())),
    [orders, query],
  )
  return (
    <div style={{ font: "14px/1.5 system-ui, sans-serif", padding: 16 }}>
      <h1 style={{ fontSize: 16, margin: "0 0 8px" }}>Orders (React)</h1>
      <input
        placeholder="Filter by customer…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ width: "100%", boxSizing: "border-box", padding: "6px 10px", marginBottom: 12 }}
      />
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "6px 8px", opacity: 0.6 }}>ID</th>
            <th style={{ textAlign: "left", padding: "6px 8px", opacity: 0.6 }}>Customer</th>
            <th style={{ textAlign: "right", padding: "6px 8px", opacity: 0.6 }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((o) => (
            <tr key={o.id}>
              <td style={{ padding: "6px 8px", borderTop: "1px solid #8883" }}>{o.id}</td>
              <td style={{ padding: "6px 8px", borderTop: "1px solid #8883" }}>{o.customer}</td>
              <td style={{ padding: "6px 8px", borderTop: "1px solid #8883", textAlign: "right" }}>
                ${o.total}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ opacity: 0.6, marginTop: 10 }}>
        {shown.length} of {orders.length} orders
      </p>
    </div>
  )
}
