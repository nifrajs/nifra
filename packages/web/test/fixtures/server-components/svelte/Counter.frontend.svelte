<script lang="ts">
import { mount, unmount, onMount } from "svelte"
let { title, slots, prefix = "" }: { title: string; prefix?: string; slots?: Record<string, string> } = $props()
import Portal from "./Portal.frontend.svelte"
import { componentPortalTarget, ownComponentPortal } from "@nifrajs/web/server-components/portal"
const portalProps = $state({ title: "", prefix: "" })
$effect(() => { portalProps.title = title; portalProps.prefix = prefix })
function portal(node: HTMLElement) {
  const target = componentPortalTarget(node, node.querySelector("[data-nifra-portal]")!)
  const instance = mount(Portal, { target, props: portalProps })
  const dispose = ownComponentPortal(node, target, () => unmount(instance))
  return { destroy() { void dispose().catch(() => window.dispatchEvent(new CustomEvent("fixture:error", { detail: "portal_cleanup" }))) } }
}
let count = $state(0)
onMount(() => { window.dispatchEvent(new Event("fixture:mounted")); return () => window.dispatchEvent(new Event("fixture:disposed")) })
</script>
<article use:portal><h2>{title}</h2><button id={prefix + "counter"} onclick={() => count++}>Count {count}</button><input id={prefix + "value"} value="original" />{#if slots?.summary}{@html slots.summary}{/if}<div data-nifra-portal="details"></div></article>
