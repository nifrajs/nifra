<script>
  import I18nProvider from "../../src/I18nProvider.svelte"
  import Report from "./i18n-report.svelte"

  let { onMissing } = $props()
  const fallback = [{ greeting: "Hi {name} - {n, plural, one {# message} other {# messages}}" }]
</script>

<I18nProvider locale="hi" messages={{ own: "अपना" }} {fallback} numberingSystem="deva" {onMissing}>
  <Report />
</I18nProvider>
