/** FIFO whose consumed entries release their references without shifting the live entries. */
export class Fifo<Item> {
  private items: (Item | undefined)[] = []
  private head = 0

  get length(): number {
    return this.items.length - this.head
  }

  push(item: Item): void {
    this.items.push(item)
  }

  shift(): Item | undefined {
    if (this.length === 0) return undefined
    const item = this.items[this.head]
    this.items[this.head++] = undefined
    if (this.head === this.items.length) this.clear()
    else if (this.head >= 64 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head)
      this.head = 0
    }
    return item
  }

  clear(): void {
    this.items.length = 0
    this.head = 0
  }
}
