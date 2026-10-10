import { expect, test } from "bun:test"
import { cardsLookBroken, generateCards, staleCards } from "./gen-llm-cards.ts"

const card = (name: string, content: string) => ({ pkg: { name }, path: `${name}/LLM.md`, content })

test("a card whose committed copy is missing or differs is stale", () => {
  const cards = [card("a", "A\n"), card("b", "B\n"), card("c", "C\n")]
  const committed = new Map([
    ["a/LLM.md", "A\n"],
    ["b/LLM.md", "B (old)\n"],
  ])
  expect(staleCards(cards, (path) => committed.get(path)).map((c) => c.pkg.name)).toEqual([
    "b",
    "c",
  ])
})

test("a generation without the web card's footguns is refused as broken", () => {
  expect(cardsLookBroken([])).toBe(true)
  expect(cardsLookBroken([card("@nifrajs/web", "# @nifrajs/web\n")])).toBe(true)
})

test("control: the real generation is not broken", () => {
  expect(cardsLookBroken(generateCards())).toBe(false)
})
