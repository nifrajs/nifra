/** @jsxImportSource preact */
export default function Detail({ params }: { readonly params: Readonly<Record<string, string>> }) {
  return <p className="detail">Detail {params.id}</p>
}
