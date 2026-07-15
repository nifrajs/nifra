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
export {
  AdapterCertificationError,
  type AdapterCertificationProfile,
  type AdapterCertificationReport,
  assertAdapterCertification,
  type CertifiableCacheEntry,
  type CertifiableCacheStore,
  type CertifiableDomainEvent,
  type CertifiableEventDeliveryAdapter,
  type CertifiableEventRecord,
  type CertifiableJobStore,
  type CertifiableRuntimeAdapter,
  type CertifiableRuntimeServer,
  type CertifiableStorageAdapter,
  type CertificationCapabilityEvidence,
  type CertificationCheck,
  type CertificationCheckEvidence,
  cacheStoreCertificationProfile,
  certifyAdapter,
  defineCertificationProfile,
  eventDeliveryCertificationProfile,
  jobStoreCertificationProfile,
  runtimeAdapterCertificationProfile,
  storageAdapterCertificationProfile,
  verifyAdapterCertification,
} from "./certification.ts"
export { type CookieJar, cookieJar } from "./cookies.ts"
export {
  createFailureLab,
  type FailureDirective,
  type FailureEvidence,
  FailureInjectedError,
  type FailureKind,
  type FailureLab,
  type FailureLabOptions,
  type FailureReplay,
  type FailureScenario,
  type FailureScenarioReport,
  runFailureScenario,
} from "./failure-lab.ts"
export {
  assertIncidentReplays,
  type CapturedRequest,
  type CapturedRequestInput,
  type CaptureIncidentOptions,
  captureIncident,
  type GenerateRegressionTestOptions,
  generateRegressionTest,
  type IncidentCapsule,
  IncidentReplayError,
  type IncidentReplayResult,
  type ReplayIncidentOptions,
  redactForEmission,
  replayIncident,
  shapeOf,
} from "./incident.ts"
export { type AppLike, type TestSession, type TestSessionOptions, testSession } from "./session.ts"
