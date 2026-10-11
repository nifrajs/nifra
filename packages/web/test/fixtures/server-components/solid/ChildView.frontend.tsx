import type { SummaryProps } from "../schema.shared"
export default function ChildView(args: {
  props: SummaryProps
  islands: { picker: { html: string } }
}) {
  return (
    <>
      child-leading
      <table>
        <tbody>
          <tr>
            <td id="child-revision">Child {args.props.revision}</td>
          </tr>
        </tbody>
      </table>
      <svg>
        <title>Fabricated component shape</title>
        <circle id="child-svg" cx="1" />
      </svg>
      <div innerHTML={args.islands.picker.html} />
      child-trailing
    </>
  )
}
