/** @jsxImportSource preact */
export default function Photo(props: { readonly data: { readonly title: string } }) {
  return <h1 id="photo-page">{props.data.title}</h1>
}
