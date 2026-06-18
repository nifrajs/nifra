import { server } from "@nifrajs/core"

// In-memory render counter — single-process demo only (a real backend would read its data from a
// shared store). It increments on every *server render* of the page, so the ISR cache lifecycle is
// directly observable: a cache HIT serves stored bytes without calling the loader (the number holds),
// while a MISS or a background REGENERATION runs the loader (the number bumps).
let renders = 0

/** The backend contract. The page loader reads the render count through an in-process client. */
export const backend = server().get("/page", () => {
  renders += 1
  return { renders }
})
