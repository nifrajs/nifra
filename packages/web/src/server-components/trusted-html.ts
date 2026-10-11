import { validateComponentHTML } from "./html.ts"

interface TrustedHTMLFactory {
  createPolicy(
    name: string,
    rules: { createHTML(html: string): string },
  ): { createHTML(html: string): unknown }
}

/** Explicit opt-in for native framework HTML sinks. Every accepted string is tokenized first. */
export function installComponentTrustedTypesPolicy(): void {
  // Trusted Types is not yet declared in all supported TypeScript DOM libraries.
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: Trusted Types is optional on globalThis and absent from some DOM type libraries; the policy still validates HTML before insertion.
  const factory = (globalThis as unknown as { trustedTypes?: TrustedHTMLFactory }).trustedTypes
  factory?.createPolicy("default", {
    createHTML(html) {
      validateComponentHTML(html)
      return html
    },
  })
}
