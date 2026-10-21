/** Slot ranges follow template composition; discarded or rewritten markup carries no ranges. */
export interface SlotRange {
  readonly name: string
  readonly start: number
  readonly end: number
}

export const templateSlots = new WeakMap<object, readonly SlotRange[]>()
