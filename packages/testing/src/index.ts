/**
 * @nifrajs/testing — helpers for testing nifra apps in-process. `@nifrajs/client`'s `testClient` is the
 * typed, no-network request client (the supertest/inject equivalent); this adds what it doesn't: a
 * {@link cookieJar} and a cookie-persisting {@link testSession}, so stateful auth/session flows are as
 * easy to test as a single request.
 *
 *   import { testSession } from "@nifrajs/testing"
 *   const { client, cookies } = testSession<typeof app>(app)
 */

export {
  AdversarialContractError,
  type AdversarialContractOptions,
  type AdversarialContractReport,
  type AdversarialContractResult,
  assertAdversarialContract,
  type ContractCaseContext,
  type ContractCaseKind,
  type ContractCoverageGap,
  type ContractCoverageGapCode,
  type ContractReplay,
  type ContractRuntime,
  type ContractTarget,
  type ContractTestApp,
  type ContractWitness,
  runAdversarialContract,
} from "./adversarial.ts"
export { type CookieJar, cookieJar } from "./cookies.ts"
export { type AppLike, type TestSession, type TestSessionOptions, testSession } from "./session.ts"
