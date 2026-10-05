import { CodeBlock } from "../../shared/highlight"
import { postMeta } from "../../shared/meta"

export const meta = postMeta(
  "optimizations-we-rejected",
  "Three optimizations we built, measured, and deleted · Nifra",
  "A schema-compiled JSON serializer, a raw-text prescan for prototype poisoning, and a single-encode response writer. Each one reads like a free win, each was built in full, and each lost on the clock. The numbers, and why 2026 engines changed the answer.",
)

const SERIALIZER = `# 1.2 KB payload, 10-item array, per operation
                                         Bun        Node
compiled check + serialize walk          3.0 us     4.9 us
native JSON.stringify                    1.16 us    1.11 us
compiled validate, then JSON.stringify   1.25 us    1.22 us

# end to end, same route, Bun
no response contract        69.5k rps
contract enforced           69.3k rps
fused serializer lane       51.6k rps     -25%`

const WRITER = `# Node, realistic GET, 4 interleaved rounds
Buffer.byteLength(body) + res.end(body)       ~55.5k rps
Buffer.from(body)       + res.end(buffer)     ~54.0k rps     -2.7%, lost 4 of 4`

export default function OptimizationsWeRejected() {
  return (
    <article className="prose">
      <h1>Three optimizations we built, measured, and deleted</h1>
      <p>
        <em>2026-09-30</em>
      </p>

      <p className="lead">
        Every one of these is a well-known technique with a good reputation. Each was implemented
        properly, with tests, and then removed because the measurement went the wrong way. The
        results are worth writing down, because the reasoning behind each idea is sound and someone
        will propose it again.
      </p>

      <h2>1. A serializer compiled from the response schema</h2>
      <p>
        The idea: if a route declares its response schema, the framework knows the shape in advance,
        so it can generate a function that validates and writes the JSON in one pass without
        discovering the keys at runtime. This is the technique that made schema-driven serializers
        famous.
      </p>
      <p>
        We built the whole lane, including a 37-case parity suite that proved the output was
        byte-identical to the generic path. Then we measured it.
      </p>
      <CodeBlock code={SERIALIZER} lang="bash" />
      <p>
        The compiled walk was two and a half to four times slower than the engine's own{" "}
        <code>JSON.stringify</code>, and the route served a quarter fewer requests.
      </p>
      <p>
        The technique dates from a time when generic stringify was slow and validators were slow.
        Neither is true now. Native stringify is vectorized C++, and a walk written in JavaScript
        does not beat it. Compiled validation costs around 100 ns. There is almost nothing left for
        fusing the two to save.
      </p>
      <p>
        The useful finding is the middle of the table: enforcing a response contract costs about
        0.3% end to end. Validating what you send is close to free, so there is no performance
        reason to leave it off.
      </p>

      <h2>2. A text prescan before the prototype-poisoning walk</h2>
      <p>
        Nifra checks every parsed JSON body for <code>__proto__</code> and{" "}
        <code>constructor.prototype</code> keys. The standard shortcut is to search the raw text for
        those strings first and skip the walk entirely when they are absent, which is nearly always.
      </p>
      <p>
        On Node 26 and Bun 1.3, the three substring searches cost two to four times as much as the
        walk they were meant to avoid, on every body shape a real API receives: records, strings,
        nested objects. The prescan only won on a body that was mostly a flat array of numbers,
        where it saved about 1.5 us on a 9 KB payload that spends 20 us in the parse regardless.
      </p>
      <p>
        It also was not as simple as it looked. A key can be spelled with a unicode escape, so the
        scan had to send every body containing a backslash-u to the walk anyway.
      </p>
      <p>What worked was making the walk itself cheaper:</p>
      <ul>
        <li>Filter scalars before pushing them onto the work stack: 1.5 to 3 times faster.</li>
        <li>
          Use an indexed loop over arrays. A <code>for...of</code> allocates an iterator per array,
          and replacing it was 4 times faster on records, 8 on strings, and 12 on numbers.
        </li>
        <li>
          Use <code>for...in</code> in place of <code>Object.keys()</code>, which removes an array
          allocation per object: about 2 times faster.
        </li>
        <li>Reuse one module-level stack across requests.</li>
        <li>
          Compare the length and first character code of a key before comparing the whole string.
        </li>
      </ul>

      <h2>3. Encoding the response body once</h2>
      <p>
        The Node adapter measures a JSON body with <code>Buffer.byteLength</code> to set{" "}
        <code>content-length</code>, then hands the string to <code>res.end</code>. That reads as
        two passes over the same string. Encoding it once into a buffer and using that for both
        looks like removing work.
      </p>
      <CodeBlock code={WRITER} lang="bash" />
      <p>
        It was slower in every pair. <code>res.end(string)</code> writes the string straight into
        the socket's outgoing buffer with no intermediate allocation, and{" "}
        <code>Buffer.byteLength</code> is a length walk, not an encode. The "double encode" costs
        less than one encode plus a fresh buffer and a copy.
      </p>

      <h2>What they have in common</h2>
      <p>
        All three replace something the engine does natively with something written in JavaScript,
        on the theory that knowing more about the data makes up the difference. On current engines
        it usually does not. The native path has had years of work, and the allocation you add to
        avoid it is often the most expensive thing in the function.
      </p>
      <p>
        The habit that caught all three is dull: build it, run it interleaved against the old
        version in both orders, and believe the result. Two of these would have shipped on review
        alone, because on the page they look like plain improvements.
      </p>
      <p>
        The benchmark method and current tables are on the <a href="/benchmarks">benchmarks page</a>
        .
      </p>
    </article>
  )
}
