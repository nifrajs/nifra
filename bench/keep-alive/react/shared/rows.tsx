type Data = {
  readonly id: string
  readonly rows: readonly { id: number; label: string; price: string }[]
}

export default function Rows({ data }: { readonly data: Data }) {
  return (
    <section className="rows">
      <h1 id="title">List {data.id}</h1>
      <ul>
        {data.rows.map((row) => (
          <li key={row.id}>
            <span>{row.label}</span> <span>{row.price}</span>
            <input type="checkbox" />
          </li>
        ))}
      </ul>
    </section>
  )
}
