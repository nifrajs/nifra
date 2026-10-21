import { live } from "@nifrajs/web/live"

/** The live runtime: the server serves its socket and load endpoint, and the vote route publishes. */
export const liveRuntime = live({
  // Required in production (`openssl rand -base64 32`); development makes one per process.
  secret: Bun.env.LIVE_SECRET,
  // One public poll: every viewer is anonymous.
  subject: () => null,
  // The page's query hook refetches on the keys its loader grants.
  queryKeys: true,
})
