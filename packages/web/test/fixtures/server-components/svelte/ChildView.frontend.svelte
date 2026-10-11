<script lang="ts">
import type { SummaryProps } from "../schema.shared"
let { props, islands }: { props: SummaryProps; islands: { picker: { html: string } } } = $props()
</script>
child-leading<table><tbody><tr><td id="child-revision">Child {props.revision}</td></tr></tbody></table><svg><circle id="child-svg" cx="1" /></svg>{@html islands.picker.html}child-trailing
