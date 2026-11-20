import { t } from "@nifrajs/schema"

export const loaderOutput = t.object({ workspace: t.string() })

export async function loader() {
  return { workspace: "Demo workspace" }
}
