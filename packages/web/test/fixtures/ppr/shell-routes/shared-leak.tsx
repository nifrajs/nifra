export const boundaries = [{ name: "greeting", mode: "shared" as const, render: () => null }]

export default function SharedLeak() {
  return null
}
