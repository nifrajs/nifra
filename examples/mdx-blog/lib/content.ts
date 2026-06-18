import { join } from "node:path"
import { defineCollection } from "@nifrajs/content/fs"
import { t } from "@nifrajs/schema"

/** A blog content collection: `content/posts/*.md`, frontmatter validated + typed by the schema. Used
 * only inside loaders (via dynamic `import()`), so this `node:fs`-backed module never reaches the client
 * bundle. For a Workers deploy you'd `bakeCollection(posts)` at build + `fromBaked` at the edge. */
export const posts = defineCollection({
  dir: join(import.meta.dir, "..", "content", "posts"),
  schema: t.object({ title: t.string(), date: t.string(), summary: t.string() }),
})
