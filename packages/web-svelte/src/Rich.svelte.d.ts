import type { MessageKey, RegisteredMessages } from "@nifrajs/i18n"
import type { Component, Snippet } from "svelte"

/** Hand-written types for `Rich.svelte` (consumers resolve these via the `./i18n` re-export). */
export interface RichProps {
  /** The catalog key, checked against the registered catalog type when one is declared. */
  key: MessageKey<RegisteredMessages>
  /** Snippets by tag name; each receives its tag's content as a snippet to render. */
  tags?: Readonly<Record<string, Snippet<[Snippet]>>>
  /** Values for the message's placeholders - always rendered as text. */
  vars?: Readonly<Record<string, unknown>>
}

declare const Rich: Component<RichProps>
export default Rich
