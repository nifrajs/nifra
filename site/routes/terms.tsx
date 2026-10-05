import { pageMeta } from "../shared/meta"

export const meta = pageMeta(
  "Nifra - Terms of Service",
  "Terms for the nifra.dev website and hosted Nifra documentation MCP server.",
  "/terms",
)

export default function Terms() {
  return (
    <article className="prose" style={{ maxWidth: 720, margin: "48px auto" }}>
      <h1>Terms of Service</h1>
      <p>
        <em>Last updated: 2026-09-30</em>
      </p>

      <h2>Scope</h2>
      <p>
        These terms apply to the nifra.dev website and the hosted Nifra documentation MCP server at
        mcp.nifra.dev. Nifra is an open-source project maintained in public.
      </p>

      <h2>Permitted use</h2>
      <p>
        You may use the website and documentation server for lawful software development,
        evaluation, research, and learning. Do not abuse the service, attempt to bypass reasonable
        rate limits or security controls, or use it to send secrets or personal data that the
        documentation tools do not need.
      </p>

      <h2>Content and open source code</h2>
      <p>
        Nifra documentation and source code are provided under the licenses stated in the relevant
        repository files. The hosted documentation server returns public, bundled documentation,
        examples, and API types. It does not provide access to private repositories, user projects,
        or a hosted application runtime.
      </p>

      <h2>Availability and disclaimers</h2>
      <p>
        The website and hosted documentation server are provided on an as-is and as-available basis.
        We do not promise uninterrupted availability, a particular response time, or that every
        documentation example is suitable for your application. You are responsible for reviewing,
        testing, and securing code before using it in production.
      </p>

      <h2>Changes and contact</h2>
      <p>
        We may update these terms when the service changes. Questions and notices can be sent
        through the <a href="/contact">Nifra contact page</a> or the public GitHub repository.
      </p>
    </article>
  )
}
