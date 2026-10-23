import { t } from "@nifrajs/schema"
import { visitorName } from "../../../../../../web/test/fixtures/ppr/app/lib/session.ts"

// Wrong on purpose: a shell must not read the visitor. The shell check refuses this route.
export const shellLoader = async () => ({ who: visitorName(new Request("https://shell.invalid/")) })
export const shellOutput = t.object({ who: t.string() })
export const boundaryLoaders = {
  note: { load: () => ({ text: "note" }), output: t.object({ text: t.string() }) },
}
