import { HOME_COUNTER_ENTRY } from "../shared/islands/entries"

// Static page - ships zero framework JS. The only client code is a tiny enhancer (the copy buttons),
// loaded through `islandScripts`. The hero walkthrough and the framework switcher are CSS-only
// (`:checked` radios), so they stay interactive with zero added JS. The playground is the /play
// route in an <iframe>, so its island loads only when the frame scrolls near.
export const hydrate = false
export const islandScripts = [HOME_COUNTER_ENTRY]
