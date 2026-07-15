import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Nifra - Adapter certification",
  "Prove a storage, cache, job, runtime, or event adapter against its interface and emit a hash-verifiable capability matrix.",
)

const CERTIFY = `// doc-check: skip - createRedisCache stands in for the adapter under test
import { test } from "bun:test"
import {
  assertAdapterCertification,
  cacheStoreCertificationProfile,
  certifyAdapter,
} from "@nifrajs/testing/certification"

test("the Redis cache adapter satisfies the cache contract", async () => {
  const report = await certifyAdapter({
    profile: cacheStoreCertificationProfile(),
    adapterId: "redis-cache",
    // A FRESH adapter per check, so one failure cannot contaminate the next.
    createAdapter: () => createRedisCache(url),
    cleanup: (adapter) => adapter.clear(),
  })

  assertAdapterCertification(report) // throws, naming every failed check
})`

const REPORT = `{
  "schemaVersion": 1,
  "ok": true,
  "profile": { "id": "cache-store", "version": 1 },
  "adapterId": "redis-cache",
  "capabilities": [
    { "capability": "read-write", "status": "passed", "checks": ["set-get", "delete"] },
    { "capability": "tag-invalidation", "status": "passed", "checks": ["invalidate-tag"] }
  ],
  "evidenceHash": "9f2c..."
}`

export default function Certification() {
  return (
    <div className="prose">
      <h1 className="page">Adapter certification</h1>
      <p className="lead">
        An interface is a promise. Certification is how an adapter proves it kept it, in a form someone
        else can check.
      </p>

      <h2>Profiles</h2>
      <p>
        A profile is a named set of checks written against an interface, not an implementation:{" "}
        <code>cacheStoreCertificationProfile</code>, <code>jobStoreCertificationProfile</code>,{" "}
        <code>storageAdapterCertificationProfile</code>, <code>runtimeAdapterCertificationProfile</code>
        , and <code>eventDeliveryCertificationProfile</code>. Domain-specific seams define their own
        with <code>defineCertificationProfile</code>, which validates the profile at module load, so a
        check naming an undeclared capability fails before any adapter runs.
      </p>

      <h2>Certify an adapter</h2>
      <CodeBlock code={CERTIFY} lang="ts" />
      <p>
        Profiles are structural and dependency-free. A third-party adapter can certify itself in its own
        test suite without adopting anything else, which is the point: trust becomes portable rather
        than something we vouch for.
      </p>

      <h2>The report is the evidence</h2>
      <CodeBlock code={REPORT} lang="json" />
      <p>
        The capability matrix is the useful artifact. It says what an adapter supports, per capability,
        with the checks that back each one. <code>verifyAdapterCertification</code> recomputes{" "}
        <code>evidenceHash</code>, so a stored report can be checked rather than believed.
      </p>

      <h2>Failures carry a class, not a message</h2>
      <p>
        A failed check records the error <em>class</em> only. Provider messages routinely carry
        connection strings, tokens, and payload fragments, and evidence is meant to be shared, so it
        never becomes a place credentials leak. Cleanup errors cannot turn a failed functional check
        into a pass.
      </p>
    </div>
  )
}
