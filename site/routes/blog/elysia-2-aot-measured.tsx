import { CodeBlock } from "../../highlight"
import { postMeta } from "../../meta"

export const hydrate = false

export const meta = postMeta(
  "elysia-2-aot-measured",
  "We measured Elysia 2's AOT mode before deciding not to copy it · Nifra",
  "Elysia 2 beta moves its handler and validator code generation to build time. We benchmarked it against Elysia 1.4 and against Nifra to decide whether Nifra needed the same thing. It does not, and the numbers say why.",
)

const STEADY = `# requests per second as a ratio, three workloads, Bun, same machine
Elysia 2 AOT   vs  Elysia 2 JIT      99%   101%   103%
Elysia 2       vs  Elysia 1.4       103%    99%   100%
nifra bundled  vs  Elysia 2 JIT     101%   103%   106%`

const COLD = `# process spawn to first 200
nifra            12.5 ms      116 KB minified
Elysia 2 AOT     25.7 ms      544 KB minified
Elysia 2 JIT     33.1 ms      433 KB minified`

const WORST = `# every fast path missed: params, query, headers, body, hooks
Bun     GET  104% of Elysia 1.4.30     POST   98%
Node    nifra 118 - 122% of Elysia,  111 - 122% of Fastify`

const GUARD = `# same POST, the prototype-poisoning guard switched off
POST   103% - 106% of Elysia 1.4.30`

export default function ElysiaTwoAotMeasured() {
  return (
    <article className="prose">
      <h1>We measured Elysia 2's AOT mode before deciding not to copy it</h1>
      <p>
        <em>
          2026-09-30 · Disclosure: we build Nifra. Elysia 2 is a beta (2.0.0-beta.19 on the{" "}
          <code>next</code> tag; stable is 1.4.30), so these numbers describe that beta and can
          change before release.
        </em>
      </p>

      <p className="lead">
        Elysia has always generated specialized handler and validator code at startup. Elysia 2 adds
        an ahead-of-time mode that does that generation in the bundler instead. The obvious question
        for another framework is whether it is now behind. We ran it to find out.
      </p>

      <h2>What AOT changes</h2>
      <p>
        The AOT mode ships as bundler plugins for Bun and esbuild. They run the same code generation
        Elysia would do on boot and freeze the result into the bundle. Two things follow from that,
        and both are real benefits:
      </p>
      <ul>
        <li>
          <strong>Cold start.</strong> The work is done before the process exists, so it is not done
          again on every boot.
        </li>
        <li>
          <strong>Strict environments.</strong> Runtime code generation needs{" "}
          <code>new Function</code>, which a content security policy or an edge runtime may forbid.
          Code generated at build time has no such requirement.
        </li>
      </ul>
      <p>
        What AOT does not change is the code that runs per request. It is the same code, produced
        earlier.
      </p>

      <h2>Steady state: no difference</h2>
      <CodeBlock code={STEADY} lang="bash" />
      <p>
        AOT and JIT are within three points of each other in both directions, which is what you
        would expect from two routes to the same generated code. Elysia 2 against Elysia 1.4 is the
        same story. Nifra is level or slightly ahead, and we would not claim more than level from
        differences this size.
      </p>

      <h2>Cold start: AOT helps Elysia</h2>
      <CodeBlock code={COLD} lang="bash" />
      <p>
        AOT takes about 7 ms off Elysia's own cold start, which is the improvement it was built for.
        It also makes the bundle larger, because the generated code now ships instead of being
        produced on the machine. Nifra starts in about half the time with a bundle under a quarter
        of the size, and it gets there without generating code at all.
      </p>

      <h2>The case we expected to lose</h2>
      <p>
        Generated code should pay off most when a route uses everything at once, because that is
        where a generic dispatcher has the most branches to take. So we built that route on purpose:
        path params, query, headers, a validated body, and hooks, with every shortcut Nifra normally
        takes made unavailable.
      </p>
      <CodeBlock code={WORST} lang="bash" />
      <p>There is no cliff. The one row under 100% is POST on Bun, and it has a specific cause.</p>

      <h2>Where the two points went</h2>
      <p>
        Nifra walks every parsed JSON body looking for <code>__proto__</code> and{" "}
        <code>constructor.prototype</code> keys before a handler sees it. Elysia does not have an
        equivalent guard. On the 66 KB body in that test the walk costs about 8 us, next to 75 us
        for the parse itself.
      </p>
      <CodeBlock code={GUARD} lang="bash" />
      <p>
        With the guard switched off, Nifra is ahead. We leave it on by default, and the 98% is what
        that default costs on a large body. It seemed better to show the number than to benchmark
        with a safety check disabled.
      </p>

      <h2>How close to the runtime is there left to get</h2>
      <p>
        The reason codegen has so little to offer here is that there is very little left above the
        runtime. A Nifra GET on Bun runs at 99% of a bare <code>Bun.serve</code> handler, and on
        Node at 101% of a bare <code>node:http</code> one. POST is at 93% and 94% of a baseline that
        skips the content-type check, the body length cap, and the prototype guard, which a real API
        needs.
      </p>

      <h2>Two traps in the measuring</h2>
      <ul>
        <li>
          Bun's CPU profiler charges native dispatch time to the first JavaScript frame it sees. A
          symbol lookup that takes about 10 ns showed up with 31.5% of self time. Treat the first
          frame of a Bun profile as a bucket, not a culprit.
        </li>
        <li>
          Running several variants through one shared loop in one process makes the first variant
          look about 1.7 ns faster than it is. Run one variant per process.
        </li>
      </ul>
      <p>
        These runs were on macOS with the machine under load, so everything above is a ratio from
        paired, count-bounded runs, and none of it is an absolute figure.
      </p>

      <h2>The decision</h2>
      <p>
        Nifra will not add a code generation or AOT step. It would cost a build plugin per bundler
        and a larger bundle, to fix a cold start that is already the faster of the two and a steady
        state that is already at the runtime's ceiling. If you use Elysia and deploy somewhere that
        forbids <code>new Function</code>, or you care about its boot time, AOT is a good reason to
        try the beta.
      </p>
      <p>
        The harness is in the repository, and the published tables are on the{" "}
        <a href="/benchmarks">benchmarks page</a>.
      </p>
    </article>
  )
}
