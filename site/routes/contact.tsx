import { pageMeta } from "../meta"

export const meta = pageMeta(
  "Nifra - Contact",
  "Contact the Nifra maintainers about documentation, bugs, features, and security issues.",
  "/contact",
  {
    structuredData: [
      {
        "@context": "https://schema.org",
        "@type": "ContactPage",
        name: "Contact Nifra",
        url: "https://nifra.dev/contact",
        mainEntity: {
          "@type": "Organization",
          name: "Nifra",
          url: "https://nifra.dev",
          sameAs: ["https://github.com/nifrajs/nifra", "https://www.npmjs.com/org/nifrajs"],
          contactPoint: [
            {
              "@type": "ContactPoint",
              contactType: "technical support",
              url: "https://github.com/nifrajs/nifra/issues",
            },
            {
              "@type": "ContactPoint",
              contactType: "security vulnerability reporting",
              email: "security@nifra.dev",
            },
          ],
        },
      },
    ],
  },
)

export default function Contact() {
  return (
    <article className="prose" style={{ maxWidth: 720, margin: "48px auto" }}>
      <h1>Contact Nifra</h1>
      <p>
        Nifra is maintained in public. The best place to ask a question, report a bug, suggest a
        feature, or correct the documentation is the GitHub issue tracker.
      </p>

      <h2>Project questions and bugs</h2>
      <p>
        <a href="https://github.com/nifrajs/nifra/issues" target="_blank" rel="noopener noreferrer">
          Open an issue on GitHub
        </a>
        . Include a minimal reproduction, the Nifra version, runtime, and the output of the relevant
        check when possible.
      </p>

      <h2>Security</h2>
      <p>
        Please do not disclose vulnerabilities in a public issue. Email{" "}
        <a href="mailto:security@nifra.dev">security@nifra.dev</a> with the impact, reproduction
        steps, and any suggested mitigation. The full policy is in the repository&apos;s{" "}
        <a
          href="https://github.com/nifrajs/nifra/blob/main/SECURITY.md"
          target="_blank"
          rel="noopener noreferrer"
        >
          SECURITY.md
        </a>
        .
      </p>
    </article>
  )
}
