import { pageMeta } from "../meta"

export const meta = pageMeta(
  "Nifra - Privacy",
  "Privacy policy for nifra.dev and the hosted nifra docs MCP server.",
  "/privacy",
)

// Kept deliberately honest and short: the site and the docs MCP are stateless documentation
// surfaces. If that ever changes (accounts, analytics with identifiers, stored queries), this page
// must change in the same release.
export default function Privacy() {
  return (
    <article className="prose" style={{ maxWidth: 720, margin: "48px auto" }}>
      <h1>Privacy</h1>
      <p>
        <em>Last updated: 2026-08-03</em>
      </p>

      <h2>What this covers</h2>
      <p>
        This policy covers the <strong>nifra.dev</strong> website and the hosted{" "}
        <strong>nifra docs MCP server</strong> at <code>mcp.nifra.dev</code> - the endpoint AI
        assistants connect to for Nifra's documentation, examples, and API types.
      </p>

      <h2>What we collect</h2>
      <p>
        <strong>Nothing that identifies you.</strong> There are no accounts, no sign-ups, no cookies
        set by us, no advertising or analytics identifiers.
      </p>
      <ul>
        <li>
          The docs MCP server is <strong>stateless and read-only</strong>: it answers each request
          from a bundled documentation corpus and stores neither your queries nor their results.
        </li>
        <li>
          Standard, short-lived operational logs (request path, status, timestamp) may exist at the
          infrastructure level to keep the service healthy and rate-limited. They are not used to
          profile users and are not shared or sold.
        </li>
        <li>
          Traffic is served through a content delivery network, which enforces its own security and
          rate-limiting; its handling of requests is governed by its own policy.
        </li>
      </ul>

      <h2>What the MCP tools can access</h2>
      <p>
        Every tool the server exposes (<code>nifra_docs</code>, <code>nifra_example</code>,{" "}
        <code>nifra_types</code>, <code>nifra_learn</code>, <code>nifra_gallery</code>) is read-only
        over public documentation. The server never reads your code, files, or any data from your
        machine or your AI assistant beyond the query text you send it.
      </p>

      <h2>Changes</h2>
      <p>
        If the site or the MCP server ever starts collecting anything beyond the above, this page
        will say so before the change ships.
      </p>

      <h2>Contact</h2>
      <p>
        Questions:{" "}
        <a href="https://github.com/nifrajs/nifra/issues" target="_blank" rel="noopener noreferrer">
          open an issue on GitHub
        </a>
        .
      </p>
    </article>
  )
}
