export default function Detail(props: { readonly params: Readonly<Record<string, string>> }) {
  return <p class="detail">Detail {props.params.id}</p>
}
