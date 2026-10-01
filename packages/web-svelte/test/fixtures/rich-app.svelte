<script>
  import I18nProvider from "../../src/I18nProvider.svelte"
  import Rich from "../../src/Rich.svelte"

  const messages = {
    terms: "Read the <link>terms and <b>all</b> rules</link>,<br/>{name}! <em>x</em>",
    count: "{n, plural, one {<b>#</b> item} other {<b>#</b> items}}",
  }
</script>

{#snippet link(content)}<a href="/terms">{@render content()}</a>{/snippet}
{#snippet b(content)}<strong>{@render content()}</strong>{/snippet}

<I18nProvider locale="en" {messages}>
  <p id="terms"><Rich key="terms" tags={{ link, b }} vars={{ name: "<b>Ada</b>" }} /></p>
  <p id="count"><Rich key="count" tags={{ b }} vars={{ n: 1200 }} /></p>
</I18nProvider>
