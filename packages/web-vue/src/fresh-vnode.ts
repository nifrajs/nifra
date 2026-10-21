import { cloneVNode, isVNode, type VNodeChild } from "vue"

/**
 * A VNode belongs to one place in one tree. A hole definition's fallback is a module-level constant
 * every render of the page shares, so each use takes a copy.
 */
export const freshVNode = (node: VNodeChild): VNodeChild =>
  isVNode(node) ? cloneVNode(node) : node
