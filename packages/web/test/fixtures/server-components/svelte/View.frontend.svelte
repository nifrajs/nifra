<script lang="ts">
import type { SummaryProps } from "../schema.shared"
let { props, islands, ranges }: { props: SummaryProps; islands: { picker: { html: string } }; ranges: Record<string, { html: string }> } = $props()
</script>
leading text<section id="revision">Revision {props.revision}</section>{#if ranges.detail && props.revision % 2 === 0}{@html ranges.detail.html}{/if}{@html islands.picker.html}{#if ranges.detail && props.revision % 2 !== 0}{@html ranges.detail.html}{/if}trailing text
