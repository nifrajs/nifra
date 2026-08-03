import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Your framework's docs should be an MCP server",
  "Most code in a modern app is written by an AI agent reading your docs. Nifra ships its documentation, runnable examples, and exact API types as a live MCP server - here is why, how it stays honest, and how to do it for your own project.",
)

const CONNECT = `# Claude Code
claude mcp add --transport http nifra https://mcp.nifra.dev

# Any MCP client: streamable HTTP endpoint
https://mcp.nifra.dev`

const ASSURE = `$ nifra assure

✖ POST /jobs (authenticated-write) is missing nifra.authenticated
  route declared: db.write
  policy: authenticated-write requires an authentication guard
  fix: add nifra.authenticated (docs: /docs/capabilities)`

const RECIPE = `1. Generate, never hand-write. Docs that humans maintain drift; docs built
   from source at release time cannot.
2. Gate staleness in CI. A generated corpus that can be forgotten is a
   hand-written corpus with extra steps.
3. Typecheck your examples. An example that does not compile against the
   current API is worse than no example.
4. Serve it over MCP. llms.txt is for crawlers; a live endpoint is for the
   agent in the editor, mid-task.
5. Make failures structured. The agent will get it wrong; the framework's
   job is to say exactly what and where, in a shape a program can act on.`

export default function DocsAsMcp() {
  return (
    <article className="prose">
      <h1>Your framework's docs should be an MCP server</h1>
      <p>
        <em>2026-08-04</em>
      </p>

      <p className="lead">
        A growing share of the code written against any framework today is written by an AI agent.
        That reader does not browse your docs site. It either knows your API from training data
        (stale the day it shipped) or it guesses. Nifra's answer: the documentation, the runnable
        examples, and the exact public API types are a live MCP server, listed in the official MCP
        registry, that any assistant can query mid-task.
      </p>

      <h2>The reader changed. Docs did not.</h2>
      <p>
        Documentation has always been written for a human on a second monitor: narrative pages,
        screenshots, a search box. The agent writing code in your editor has none of that context.
        What it has is whatever your framework looked like in its training data, which for a young
        or fast-moving project means an API surface that is months out of date or entirely
        hallucinated. Every framework maintainer has seen the result: issues opened against methods
        that never existed, generated code importing from paths that were renamed two releases ago.
      </p>
      <p>
        The stopgap is <code>llms.txt</code> - a crawlable corpus for training and retrieval. Nifra
        ships that too. But a static file answers the question "what did this framework look like
        when the corpus was fetched", and the question that matters mid-task is "what is the exact
        signature of this function, right now, in the version I have installed".
      </p>

      <h2>What a live docs endpoint looks like</h2>
      <p>
        <code>mcp.nifra.dev</code> is a hosted MCP server (streamable HTTP, no auth, stateless and
        read-only). Connected to Claude Code, Cursor, or any MCP client, an assistant can search the
        documentation, pull complete runnable examples, and read the exact TypeScript types of the
        public API - the same corpus for every tool, generated from the same source the npm packages
        are built from.
      </p>
      <CodeBlock code={CONNECT} lang="bash" />
      <p>
        It is registered as <code>io.github.nifrajs/nifra-docs</code> in the official MCP registry,
        which means clients that browse the registry can discover it without any of this setup.
      </p>
      <p>
        There is a second, more interesting endpoint: every nifra project is itself an MCP surface.{" "}
        <code>nifra mcp</code> exposes the app's real routes, schemas, and verification commands to
        the assistant working on it - not what the docs say a nifra app looks like, but what{" "}
        <em>this</em> app's contract actually is. The generic docs server answers "how does the
        framework work"; the project server answers "what did we build".
      </p>

      <h2>Machine docs that cannot lie</h2>
      <p>
        The failure mode of every machine-readable corpus is staleness. If the corpus is maintained
        by hand, it drifts from the code within weeks, and now the agent is confidently wrong with
        citations. So the rule in nifra's repo is that no machine-facing doc is hand-written:
      </p>
      <ul>
        <li>
          The API reference, the per-package contract cards, and the <code>llms.txt</code> /{" "}
          <code>llms-full.txt</code> corpora are generated from source, and CI rejects a commit
          where the generated output is stale. The docs cannot trail the code because the build
          fails if they do.
        </li>
        <li>
          The types corpus is extracted from the built packages - the same declaration files
          TypeScript users consume - so "what does this function accept" has exactly one answer.
        </li>
        <li>
          Every self-contained example in the corpus is typechecked against the live API on every
          commit. At the time of writing that is 71 examples that provably compile. An example that
          stops compiling stops the merge.
        </li>
      </ul>
      <p>
        None of this is exotic engineering. It is the same discipline as testing, applied to the
        artifact your newest and fastest-growing user population actually reads.
      </p>

      <h2>The other half: structured failure</h2>
      <p>
        Docs get the agent to write plausible code. The framework's second job is catching the
        implausible parts, in a form the agent can act on. Nifra's verification commands (
        <code>nifra check</code>, <code>nifra assure</code>, <code>nifra doctor</code>) exist for
        humans, but their output is designed for the other reader:
      </p>
      <CodeBlock code={ASSURE} lang="bash" />
      <p>
        That is a complete loop: the agent scaffolds a route, the policy engine refuses it with the
        rule that failed and the fix that satisfies it, the agent applies the fix and re-runs. No
        human in the middle, no prose error to misparse. In practice this loop is where the
        agent-native design pays for itself - not in writing the first draft, but in converging on a
        correct one.
      </p>

      <h2>Do this for your project</h2>
      <p>The recipe generalizes to any framework or library:</p>
      <CodeBlock code={RECIPE} lang="text" />
      <p>
        The pieces are independently useful, but the compounding effect comes from all five: the
        agent reads true docs, writes against true types, verifies against real rules, and fixes
        what it got wrong - against your current release, not your training-data ghost.
      </p>

      <h2>Try it</h2>
      <p>
        Add <code>https://mcp.nifra.dev</code> to your MCP client and ask it something specific
        about nifra - then scaffold an app with <code>bunx create-nifra</code> and watch the
        verification loop run. Setup for each client is on the{" "}
        <a href="/docs/agents">agents page</a>. If you maintain a framework and want to compare
        notes on any of this, the <a href="https://github.com/nifrajs/nifra">repo</a> is open.
      </p>
    </article>
  )
}
