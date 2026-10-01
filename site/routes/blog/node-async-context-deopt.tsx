import { CodeBlock } from "../../shared/highlight"
import { postMeta } from "../../shared/meta"

export const meta = postMeta(
  "node-async-context-deopt",
  "The 1.1 microseconds Node charged every request · Nifra",
  "A Node HTTP server that first touches AsyncContextFrame after its tick loop is hot pays for it on every tick for the life of the process. How we found it, what ruled out the obvious suspects, and the one-line fix that closed Nifra's GET gap to Fastify.",
)

const SYMPTOM = `# user CPU per request, bare GET, Linux rig, same machine
nifra (node)   9.28 us
fastify        8.34 - 8.60 us`

const RULED_OUT = `# syscalls per request, nifra vs fastify
read          1.002   1.002
write         1.002   1.002
writev        1.000   1.000
epoll_pwait   0.126   0.126`

const TELL = `# CPU profile, frames present in nifra and absent from fastify
exchange  @ async_context_frame
current   @ async_context_frame
set       @ async_context_frame       230 samples

processTicksAndRejections self time   2.4x fastify's`

const FIX = `import { AsyncLocalStorage } from "node:async_hooks"

// Before the first request. Constructing one store is enough to make Node
// switch AsyncContextFrame to its active implementation now, while nothing
// that depends on it has been optimized yet.
new AsyncLocalStorage()`

const RESULT = `# 6 interleaved pairs, both orders, bare GET
before   9.28 us user CPU / request
after    8.20 us user CPU / request     -1.08 us  (-11.6%)   12 of 12 runs agree

# after the fix
                 bare GET            full middleware stack
nifra (node)     8.34 - 8.59 us      10.68 us
fastify          8.34 - 8.60 us      10.53 us`

export default function NodeAsyncContextDeopt() {
  return (
    <article className="prose">
      <h1>The 1.1 microseconds Node charged every request</h1>
      <p>
        <em>2026-09-30</em>
      </p>

      <p className="lead">
        On Node, Nifra's plain GET was consistently slower than Fastify's by about a microsecond of
        user CPU per request. The cause was not in our router, our response writer, or the kernel.
        It was the moment in the process's life at which one internal Node class was first touched.
      </p>

      <h2>The symptom</h2>
      <p>
        The gap was small, stable, and would not go away. It showed up as CPU per request rather
        than as a latency spike, which is the signature of extra work on every request rather than
        an occasional stall.
      </p>
      <CodeBlock code={SYMPTOM} lang="bash" />

      <h2>What it was not</h2>
      <p>
        Three suspects were cleared before the real one turned up, and each was cleared by
        measurement rather than by argument.
      </p>
      <ul>
        <li>
          <strong>The kernel.</strong> Both servers made the same system calls at the same rate, to
          three decimal places. Whatever the difference was, it lived in user space.
        </li>
        <li>
          <strong>Payload size.</strong> The gap stayed between 0.5 and 1.0 us as the response grew
          from 578 to 3,363 bytes. A cost that does not scale with bytes is not an encoding or a
          copying cost.
        </li>
        <li>
          <strong>Garbage collection and worker threads.</strong> Together they accounted for 0.06
          us of a 0.84 us difference.
        </li>
      </ul>
      <CodeBlock code={RULED_OUT} lang="bash" />

      <h2>The tell</h2>
      <p>
        With those gone, the profile had one thing left to say. Nifra's had frames from Node's
        async-context machinery that Fastify's did not have at all, and the function that drains the
        microtask and tick queues was spending 2.4 times as long in its own body.
      </p>
      <CodeBlock code={TELL} lang="bash" />
      <p>
        Neither server used <code>AsyncLocalStorage</code> on that route. So why did only one of
        them show the frames?
      </p>

      <h2>The cause</h2>
      <p>
        On Node 26, <code>AsyncContextFrame</code> starts out inactive, and its methods are no-ops.
        The first read of its <code>enabled</code> flag swaps the class over to the active
        implementation. Every HTTP server triggers that read sooner or later, because closing a
        socket clears a timer and clearing a timer asks the async-context layer to forget it.
      </p>
      <p>The difference between the two servers was when.</p>
      <ul>
        <li>
          Fastify touches it while booting, about 0.2 seconds into the process, before any request
          has been served.
        </li>
        <li>
          Nifra first touched it when the first connection closed, about 2 seconds in and well into
          the load.
        </li>
      </ul>
      <p>
        By then V8 had already optimized the tick loop with the inactive no-op methods inlined.
        Swapping the implementation underneath it invalidated that code, and the call site stayed
        slower for the rest of the process's life. Nothing was wrong with either implementation. The
        order of two events was the whole bug.
      </p>
      <p>
        The proof took one line: construct an <code>AsyncLocalStorage</code> at boot and do nothing
        with it. Samples in the tick loop dropped from 449 to 95. Fastify's count on the same run
        was 89.
      </p>

      <h2>The fix</h2>
      <p>
        <code>serve()</code> in <code>@nifrajs/node</code> now activates the frame before it starts
        listening. The general form, for any Node server, is this:
      </p>
      <CodeBlock code={FIX} lang="ts" />
      <CodeBlock code={RESULT} lang="bash" />
      <p>
        The bare GET is now inside Fastify's own run-to-run range. The full-stack row is 1.4% apart,
        which is under the 2 to 5% noise floor of the rig, so we call that a tie and not a win.
      </p>

      <h2>Two things we fixed in our own benchmark first</h2>
      <p>
        Before trusting any of this, the comparison itself had to be fair, and it was not. Both
        defects flattered Nifra.
      </p>
      <ul>
        <li>
          The Fastify arm declared its hooks <code>async</code>, which charged it two extra
          microtasks per request that an idiomatic Fastify app would not pay.
        </li>
        <li>
          The peer servers sent a strict-transport-security header and omitted <code>vary</code>, so
          the responses differed by 66 bytes.
        </li>
      </ul>
      <p>
        Both were corrected before the numbers above were taken. A benchmark you maintain yourself
        drifts in your own favor unless you go looking for the places it does.
      </p>

      <h2>What to take from it</h2>
      <p>
        If you run a Node HTTP server and do not already create an <code>AsyncLocalStorage</code> at
        startup, the experiment costs one line and a before-and-after profile. Look for{" "}
        <code>async_context_frame</code> frames and for self time in{" "}
        <code>processTicksAndRejections</code>. The method is in the{" "}
        <a href="/benchmarks">benchmark notes</a>, and the rig is in the repository.
      </p>
    </article>
  )
}
