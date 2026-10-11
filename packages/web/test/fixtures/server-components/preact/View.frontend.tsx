import type { SummaryProps } from "../schema.shared"
export default function View(args: {
  props: SummaryProps
  islands: { picker: { html: string } }
  ranges: Record<string, { html: string }>
}) {
  return (
    <>
      leading text<section id="revision">Revision {args.props.revision}</section>
      <div
        dangerouslySetInnerHTML={{
          __html: args.props.revision % 2 === 0 ? (args.ranges.detail?.html ?? "") : "",
        }}
      />
      <div dangerouslySetInnerHTML={{ __html: args.islands.picker.html }} />
      <div
        dangerouslySetInnerHTML={{
          __html: args.props.revision % 2 !== 0 ? (args.ranges.detail?.html ?? "") : "",
        }}
      />
      trailing text
    </>
  )
}
