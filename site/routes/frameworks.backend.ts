import { FRAMEWORKS_ENTRY } from "../shared/islands/entries"

// Static showcase: the host route ships NO framework runtime of its own (`hydrate: false`). Each of the
// five rows is server-rendered into its own stage; the toggle island (vanilla JS) lazily hydrates the
// shown one by loading that framework's real client bundle. So React never re-renders this DOM, and the
// only request-time cost is five small HTML fragments + one ~1 KB island.
export const hydrate = false
export const islandScripts = [FRAMEWORKS_ENTRY]
