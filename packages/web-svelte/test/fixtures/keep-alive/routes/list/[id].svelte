<script module>
  export const keepAlive = true

  const ticks = () => {
    const held = Reflect.get(globalThis, "__ticks")
    if (held !== undefined) return held
    const fresh = {}
    Reflect.set(globalThis, "__ticks", fresh)
    return fresh
  }
  const lines = Array.from({ length: 40 }, (_, i) => i)
</script>

<script>
  import { onPageHide, onPageShow } from "@nifrajs/web-svelte/router"
  let { data, params } = $props()
  const instance = $props.id()
  let count = $state(0)
  let visible = $state(true)
  let timer
  const start = () => {
    timer = setInterval(() => {
      const all = ticks()
      all[instance] = (all[instance] ?? 0) + 1
    }, 10)
  }
  $effect(() => {
    start()
    return () => clearInterval(timer)
  })
  onPageHide(() => {
    visible = false
    clearInterval(timer)
  })
  onPageShow(() => {
    visible = true
    start()
  })
</script>

<section class="list-page" data-instance={instance} data-param={params.id} data-visible={String(visible)}>
  <h1 id="list-title">List {data.id}</h1>
  <button type="button" class="count" onclick={() => count++}>count {count}</button>
  <details class="more">
    <summary>More</summary>
    <p>Details for list {data.id}</p>
  </details>
  <input class="draft" value="" />
  <div class="inner-scroll" style="height:80px;overflow:auto">
    {#each lines as i (i)}
      <p>line {i}</p>
    {/each}
  </div>
  <ul>
    {#each data.items as item (item.id)}
      <li data-id={item.id}>
        <span>{item.label}</span>
        <input type="checkbox" />
      </li>
    {/each}
  </ul>
</section>
