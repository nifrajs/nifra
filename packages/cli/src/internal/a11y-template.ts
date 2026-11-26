import {
  type A11yFinding,
  type AttributeValue,
  type ElementAttribute,
  judgeElement,
} from "./a11y-element.ts"
import { readAttributes, scanTemplate, type TemplateAttribute } from "./template-markup.ts"

const INTRINSIC = /^[a-z][a-z0-9]*$/
const OTHER: AttributeValue = { kind: "other" }

/** An attribute that may bring in any other: a Svelte `{...props}` or a Vue `v-bind="props"` / `:[name]`. */
const spreads = (name: string): boolean =>
  /^\{\s*\.\.\./.test(name) ||
  name === "v-bind" ||
  name.startsWith(":[") ||
  name.startsWith("v-bind:[")

/** The attribute an element carries under this written name: undefined for a directive (`on:click`,
 * `@click`, `v-if`, `use:action`), which is not one. A bound value (`:role`, `v-bind:role`, Svelte's
 * `{role}`) is named but its value is not read. */
function attributeName(
  name: string,
): { readonly name: string; readonly bound: boolean } | undefined {
  const shorthand = /^\{\s*([\w-]+)\s*\}$/.exec(name)
  if (shorthand?.[1] !== undefined) return { name: shorthand[1].toLowerCase(), bound: true }
  const bound = name.startsWith(":") || name.startsWith("v-bind:")
  const plain = name.startsWith(":")
    ? name.slice(1)
    : name.startsWith("v-bind:")
      ? name.slice(7)
      : name
  if (/[:@#]/.test(plain) || plain.startsWith("v-")) return undefined
  return { name: (plain.split(".")[0] ?? plain).toLowerCase(), bound }
}

const attributeValue = (attribute: TemplateAttribute, bound: boolean): AttributeValue => {
  if (bound) return OTHER
  const literal = attribute.quoted ?? attribute.braceString ?? attribute.bare
  // A Svelte `alt="{name} photo"` holds an expression: its text is not what the page renders.
  if (literal !== undefined) return /[{}]/.test(literal) ? OTHER : { kind: "text", text: literal }
  if (attribute.braced !== undefined && /^\s*\d+\s*$/.test(attribute.braced))
    return { kind: "text", text: attribute.braced.trim() }
  return OTHER
}

/**
 * The accessibility findings in the template of a `.vue` or `.svelte` file, judged by the same rules as
 * JSX. `vue` reads a Vue file's `<template>`; otherwise the file is Svelte, whose markup is the whole
 * file outside its `<script>` and `<style>`. Offsets are into `text`.
 */
export function a11yTemplateFindings(
  text: string,
  vue: boolean,
): { readonly findings: readonly A11yFinding[]; readonly expectationLines: readonly string[] } {
  const { tags, expectationLines } = scanTemplate(text, vue)
  const findings: A11yFinding[] = []
  for (const tag of tags) {
    if (!tag.inTemplate || !INTRINSIC.test(tag.written)) continue
    const written = readAttributes(text, tag)
    if (written.some((attribute) => spreads(attribute.name))) continue
    const attributes = new Map<string, ElementAttribute>()
    for (const attribute of written) {
      const named = attributeName(attribute.name)
      if (named === undefined) continue
      attributes.set(named.name, {
        at: attribute.at,
        value: attributeValue(attribute, named.bound),
      })
    }
    findings.push(...judgeElement(tag.name, attributes, tag.at))
  }
  return { findings: findings.sort((a, b) => a.position - b.position), expectationLines }
}
