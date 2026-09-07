import { pageMeta } from "../meta"

export const meta = pageMeta(
  "Nifra - About",
  "Nifra is an open-source TypeScript framework for typed APIs, full-stack SSR, and agent-safe application development.",
  "/about",
  {
    structuredData: [
      {
        "@context": "https://schema.org",
        "@type": "AboutPage",
        name: "About Nifra",
        url: "https://nifra.dev/about",
        mainEntity: {
          "@type": "SoftwareApplication",
          name: "Nifra",
          applicationCategory: "DeveloperApplication",
          codeRepository: "https://github.com/nifrajs/nifra",
          url: "https://nifra.dev",
        },
      },
    ],
  },
)

export default function About() {
  return (
    <article className="prose" style={{ maxWidth: 720, margin: "48px auto" }}>
      <h1>About Nifra</h1>
      <p>
        Nifra is an open-source, Bun-native TypeScript framework for building typed HTTP APIs and
        full-stack applications that stay understandable and verifiable as humans and coding agents
        change them.
      </p>

      <h2>What Nifra provides</h2>
      <p>
        The framework combines a contract-first HTTP core, a zero-codegen typed client, runtime
        validation, SSR across five UI libraries, and one deployment model for Bun, Node, Deno, and
        the edge.
      </p>
      <p>
        Its agent layer exposes live project context, verified examples, real request checks, MCP,
        A2A, and AG-UI bridges. The goal is simple: an agent should be able to read the real
        contract, make a change, and prove that the change still works.
      </p>

      <h2>Built in public</h2>
      <p>
        Nifra is maintained in the{" "}
        <a href="https://github.com/nifrajs/nifra" target="_blank" rel="noopener noreferrer">
          public GitHub repository
        </a>{" "}
        and published through the{" "}
        <a href="https://www.npmjs.com/org/nifrajs" target="_blank" rel="noopener noreferrer">
          @nifrajs npm organization
        </a>
        . Read the <a href="/docs">documentation</a> or connect an assistant to the{" "}
        <a href="https://mcp.nifra.dev" target="_blank" rel="noopener noreferrer">
          hosted docs MCP server
        </a>
        .
      </p>
    </article>
  )
}
