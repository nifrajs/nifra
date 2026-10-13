<!--
  I18nProvider.svelte - provides a nifra i18n `Formatter` (built from `locale` + `messages`, with the
  optional `fallback`, `onMissing`, `timeZone` and `numberingSystem` of `createFormatter`) to the
  subtree via Svelte context; consumers read it with `useT()` from `@nifrajs/web-svelte/i18n`. The
  formatter is `$derived`, so switching locale rebuilds it. `locale` + `messages` are serializable, so
  SSR renders the negotiated catalog and the client rebuilds the same formatter on hydrate (no
  mismatch). In an app that registers its locale routing, `locale` defaults to the page's. Plain-JS
  script. The context keys are strings (kept in sync with i18n.ts and Chain.svelte) so this component
  needs no `.ts` import.
-->
<script>
  import { createFormatter } from "@nifrajs/i18n"
  import { localeOfProps } from "@nifrajs/web/client"
  import { getContext, setContext } from "svelte"

  let { locale, messages, fallback, onMissing, timeZone, numberingSystem, children } = $props()
  const renderProps = getContext("@nifrajs/web-svelte:props")

  const formatter = $derived.by(() => {
    const active = locale ?? localeOfProps(renderProps?.())?.lang
    if (active === undefined) {
      throw new Error(
        "[nifra/web-svelte] <I18nProvider> needs a `locale`, or an app that registers its locale routing (export `i18n` from backend/framework.ts)",
      )
    }
    return createFormatter(active, messages, { fallback, onMissing, timeZone, numberingSystem })
  })
  // A getter (not the value) so consumers read the current `$derived` formatter reactively.
  setContext("@nifrajs/web-svelte:i18n", () => formatter)
</script>

{@render children?.()}
