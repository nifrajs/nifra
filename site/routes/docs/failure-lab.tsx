import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Nifra - Failure laboratory",
  "Replayable durable-failure schedules on virtual time: crash after commit, duplicate delivery, reordering, budget expiry, and checkpoint contention.",
)

const LAB = `import { createFailureLab } from "@nifrajs/testing"

const lab = createFailureLab({
  seed: 77,
  schedule: [
    { kind: "duplicate-delivery", point: "relay.batch", copies: 3 },
    { kind: "reorder-events", point: "relay.batch" },
  ],
})

// The adapter under test just names its seams. Same seed, same schedule,
// same result - every run.
const delivered = lab.deliveries("relay.batch", ["evt-a", "evt-b", "evt-c"])`

const SCENARIO = `// doc-check: skip - commit/publish/outboxStillPending stand in for the system under test
import { runFailureScenario } from "@nifrajs/testing"

const report = await runFailureScenario(
  {
    name: "crash-after-commit",
    execute: async (lab) => {
      await commit()
      lab.checkpoint("outbox.after-commit") // crashes here, per the schedule
      await publish()
      return "published"
    },
    // The scenario passes only if the invariant survives the failure.
    verify: async ({ error }) => error !== undefined && (await outboxStillPending()),
  },
  { seed: 1, schedule: [{ kind: "crash", point: "outbox.after-commit" }] },
)

report.ok // did the invariant hold?
report.replay // { seed, schedule } - reproduces this exact run`

export default function FailureLab() {
  return (
    <div className="prose">
      <h1 className="page">Failure laboratory</h1>
      <p className="lead">
        Durable systems fail on a schedule you never chose: the crash lands between the commit and the
        publish, the queue delivers twice, the events arrive backwards. The laboratory lets you choose
        that schedule, then replay it exactly.
      </p>

      <h2>Seven failures worth testing</h2>
      <ul>
        <li>
          <code>crash</code> - stop dead at a named durability seam.
        </li>
        <li>
          <code>duplicate-delivery</code> - deliver the same batch N times.
        </li>
        <li>
          <code>reorder-events</code> - rotate a batch out of order.
        </li>
        <li>
          <code>delay</code> - advance virtual time, with no real sleeping.
        </li>
        <li>
          <code>expire-budget</code> - report zero remaining at a budget seam.
        </li>
        <li>
          <code>lose-provider-reply</code> - run the call, then lose only its reply.
        </li>
        <li>
          <code>contend-checkpoint</code> - make a checkpoint conflict.
        </li>
      </ul>

      <h2>Place the seams, schedule the failure</h2>
      <CodeBlock code={LAB} lang="ts" />
      <p>
        The controller is an off-hot-path port. Your adapter names its seams; the schedule decides what
        happens at them. Time is virtual, so a 24-hour delay costs nothing and nothing is flaky.
      </p>

      <h2>Assert the invariant, not the output</h2>
      <CodeBlock code={SCENARIO} lang="ts" />
      <p>
        A scenario passes only when <code>verify</code> returns true after the failure. Losing the
        provider reply is not a bug; losing the money is. That distinction is the whole point.
      </p>

      <h2>Evidence is tokens only</h2>
      <p>
        Injection evidence records the kind, the point, the occurrence, and the virtual time. Never
        payloads, provider results, exception messages, or stacks. A failing report carries the error{" "}
        <em>class</em> and the exact <code>replay</code> inputs, so it reproduces from the report alone
        without leaking what flowed through the system.
      </p>

      <h2>Where it fits</h2>
      <p>
        The same engine backs <code>nifra levels</code> L4. Contract invariants fuzz the HTTP surface;
        the laboratory covers the durable paths underneath, where the interesting failures live.
      </p>
    </div>
  )
}
