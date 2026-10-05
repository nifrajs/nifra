import type { SummaryProps } from "../schema.shared"
export default function View(args: {
  props: SummaryProps
  islands: { picker: { html: string } }
  ranges: Record<string, { html: string }>
}) {
  return (
    <>
      leading text<section id="revision">Revision {args.props.revision}</section>
      <div innerHTML={args.props.revision % 2 === 0 ? (args.ranges.detail?.html ?? "") : ""} />
      <div innerHTML={args.islands.picker.html} />
      <div innerHTML={args.props.revision % 2 !== 0 ? (args.ranges.detail?.html ?? "") : ""} />
      trailing text
    </>
  )
}
