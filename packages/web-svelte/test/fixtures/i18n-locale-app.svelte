<script>
  import { setContext } from "svelte"
  import I18nProvider from "../../src/I18nProvider.svelte"
  import Report from "./i18n-locale-report.svelte"

  let { renderProps, locale } = $props()
  // The key Chain.svelte provides the render's props under.
  if (renderProps !== undefined) setContext("@nifrajs/web-svelte:props", () => renderProps)
</script>

<I18nProvider {locale} messages={{}}>
  <Report />
</I18nProvider>
