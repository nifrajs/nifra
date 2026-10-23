export const boundaries = [
  { name: "cart", mode: "dynamic" as const, render: () => null },
  { name: "price", mode: "shared" as const, render: () => null },
  { name: "stock", mode: "shared" as const, render: () => null },
]

export default function SharedHole() {
  return null
}
