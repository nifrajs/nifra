// The spike's counter island — what a hotel-comparator "save/compare" widget would be.
import { mount } from "../src/bind.ts"
import { signal } from "../src/signals.ts"

const count = signal(0)
mount(
  document,
  { count: count as never },
  {
    inc: () => count.set((n) => n + 1),
    dec: () => count.set((n) => n - 1),
  },
)
