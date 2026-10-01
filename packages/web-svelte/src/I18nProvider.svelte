<!--
  I18nProvider.svelte - provides a nifra i18n `Formatter` (built from `locale` + `messages`, with the
  optional `fallback`, `onMissing`, `timeZone` and `numberingSystem` of `createFormatter`) to the
  subtree via Svelte context; consumers read it with `useT()` from `@nifrajs/web-svelte/i18n`. The
  formatter is `$derived`, so switching locale rebuilds it. `locale` + `messages` are serializable, so
  SSR renders the negotiated catalog and the client rebuilds the same formatter on hydrate (no
  mismatch). Plain-JS script. The context key is a string (kept in sync with i18n.ts's `useT`) so this
  component needs no `.ts` import.
-->
<script>
  import { createFormatter } from "@nifrajs/i18n"
  import { setContext } from "svelte"

  let { locale, messages, fallback, onMissing, timeZone, numberingSystem, children } = $props()

  const formatter = $derived(
    createFormatter(locale, messages, { fallback, onMissing, timeZone, numberingSystem }),
  )
  // A getter (not the value) so consumers read the current `$derived` formatter reactively.
  setContext("@nifrajs/web-svelte:i18n", () => formatter)
</script>

{@render children?.()}
