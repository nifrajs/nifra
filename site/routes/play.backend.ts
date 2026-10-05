import { PLAYGROUND_ENTRY } from "../shared/islands/entries"

// Static page (no React client entry) - the interactive logic ships as a vanilla-JS island that
// bundles @nifrajs/core + schema + runner and runs the user's app via app.fetch, entirely client-side.
// The home page embeds this route in an <iframe> as /play?embed=1.
// `hydrate: false` keeps React from re-rendering (and resetting) the DOM the island owns.
export const hydrate = false
export const islandScripts = [PLAYGROUND_ENTRY]
