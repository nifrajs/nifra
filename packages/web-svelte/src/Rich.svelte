<!--
  Rich.svelte - renders the catalog message at `key` with its tags (`<b>…</b>`, `<br/>`) drawn by the
  snippets in `tags`, from the formatter `<I18nProvider>` provides. No HTML and no `{@html}`: each
  snippet receives its tag's content as a snippet (`{#snippet b(content)}<strong>{@render
  content()}</strong>{/snippet}`), a tag with no snippet renders its content as text, `<br/>` is a
  `<br>` unless `tags.br` is given, and interpolated `vars` are always text. Plain-JS script; the
  context key is the string i18n.ts's `useT` reads.
-->
<script>
  import { rich } from "@nifrajs/i18n/rich"
  import { getContext } from "svelte"

  let { key, tags = {}, vars } = $props()

  const formatter = getContext("@nifrajs/web-svelte:i18n")
  if (formatter === undefined) {
    throw new Error("[nifra/web-svelte] <Rich> must be used within an <I18nProvider>")
  }

  // Each tag becomes a plain `{ tag, chunks }` record; the template below draws it with the caller's
  // snippet. Null prototype, own names only, so `<constructor>` is never a handler.
  const parts = $derived.by(() => {
    const handlers = Object.create(null)
    handlers.br = (chunks) => ({ tag: "br", chunks })
    for (const name of Object.keys(tags)) {
      if (typeof tags[name] === "function") handlers[name] = (chunks) => ({ tag: name, chunks })
    }
    return rich(formatter(), key, handlers, vars)
  })
</script>

{#snippet draw(chunks)}{#each chunks as chunk}{#if typeof chunk === "string"}{chunk}{:else}{#snippet content()}{@render draw(chunk.chunks)}{/snippet}{#if Object.hasOwn(tags, chunk.tag) && typeof tags[chunk.tag] === "function"}{@render tags[chunk.tag](content)}{:else}<br />{@render content()}{/if}{/if}{/each}{/snippet}{@render draw(parts)}
