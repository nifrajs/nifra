/**
 * Safe, source-preserving Tailwind utility migration for StyleX.
 *
 * This is intentionally a bounded codemod rather than a Tailwind interpreter. Static utilities with
 * a direct StyleX equivalent are rewritten; dynamic className expressions, parent-dependent variants,
 * arbitrary values, and utilities outside the table are left untouched and reported.
 */
import { readdir, readFile, writeFile } from "node:fs/promises"
import { relative, resolve } from "node:path"

export interface MigrationIssue {
  readonly file: string
  readonly line: number
  readonly token: string
  readonly reason: string
}

export interface SourceMigration {
  readonly source: string
  readonly changed: boolean
  readonly replacements: number
  readonly issues: readonly MigrationIssue[]
}

export interface StylexMigrationOptions {
  readonly write?: boolean
}

export interface StylexMigrationFile {
  readonly file: string
  readonly changed: boolean
  readonly replacements: number
  readonly written: boolean
  readonly issues: readonly MigrationIssue[]
}

export interface StylexMigrationResult {
  readonly ok: boolean
  readonly from: "tailwind"
  readonly to: "stylex"
  readonly write: boolean
  readonly scanned: number
  readonly changed: readonly string[]
  readonly written: readonly string[]
  readonly issues: readonly MigrationIssue[]
  readonly files: readonly StylexMigrationFile[]
}

interface StyleObject {
  readonly [key: string]: string | number | StyleObject
}

interface UtilityConversion {
  readonly style?: StyleObject
  readonly reason?: string
}

interface ClassAttribute {
  readonly start: number
  readonly end: number
  readonly value?: string
  readonly expression?: string
}

const SOURCE_FILE = /\.[cm]?[jt]sx?$/
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".planning",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "public",
  "vendor",
])

const BREAKPOINTS: Readonly<Record<string, string>> = {
  sm: "640px",
  md: "768px",
  lg: "1024px",
  xl: "1280px",
  "2xl": "1536px",
}

const SPACING: Readonly<Record<string, string | number>> = {
  "0": 0,
  px: "1px",
  "0.5": "0.125rem",
  "1": "0.25rem",
  "1.5": "0.375rem",
  "2": "0.5rem",
  "2.5": "0.625rem",
  "3": "0.75rem",
  "3.5": "0.875rem",
  "4": "1rem",
  "5": "1.25rem",
  "6": "1.5rem",
  "7": "1.75rem",
  "8": "2rem",
  "9": "2.25rem",
  "10": "2.5rem",
  "11": "2.75rem",
  "12": "3rem",
  "14": "3.5rem",
  "16": "4rem",
  "20": "5rem",
  "24": "6rem",
  "28": "7rem",
  "32": "8rem",
  "36": "9rem",
  "40": "10rem",
  "44": "11rem",
  "48": "12rem",
  "52": "13rem",
  "56": "14rem",
  "60": "15rem",
  "64": "16rem",
  "72": "18rem",
  "80": "20rem",
  "96": "24rem",
}

const FRACTIONS: Readonly<Record<string, string>> = {
  "1/2": "50%",
  "1/3": "33.333333%",
  "2/3": "66.666667%",
  "1/4": "25%",
  "2/4": "50%",
  "3/4": "75%",
  "1/5": "20%",
  "2/5": "40%",
  "3/5": "60%",
  "4/5": "80%",
  "1/6": "16.666667%",
  "2/6": "33.333333%",
  "3/6": "50%",
  "4/6": "66.666667%",
  "5/6": "83.333333%",
  "1/12": "8.333333%",
  "2/12": "16.666667%",
  "3/12": "25%",
  "4/12": "33.333333%",
  "5/12": "41.666667%",
  "6/12": "50%",
  "7/12": "58.333333%",
  "8/12": "66.666667%",
  "9/12": "75%",
  "10/12": "83.333333%",
  "11/12": "91.666667%",
}

const COLORS: Readonly<Record<string, string>> = {
  transparent: "transparent",
  current: "currentColor",
  inherit: "inherit",
  black: "#000000",
  white: "#ffffff",
  "slate-50": "#f8fafc",
  "slate-100": "#f1f5f9",
  "slate-200": "#e2e8f0",
  "slate-300": "#cbd5e1",
  "slate-400": "#94a3b8",
  "slate-500": "#64748b",
  "slate-600": "#475569",
  "slate-700": "#334155",
  "slate-800": "#1e293b",
  "slate-900": "#0f172a",
  "slate-950": "#020617",
  "gray-50": "#f9fafb",
  "gray-100": "#f3f4f6",
  "gray-200": "#e5e7eb",
  "gray-300": "#d1d5db",
  "gray-400": "#9ca3af",
  "gray-500": "#6b7280",
  "gray-600": "#4b5563",
  "gray-700": "#374151",
  "gray-800": "#1f2937",
  "gray-900": "#111827",
  "gray-950": "#030712",
  "red-50": "#fef2f2",
  "red-100": "#fee2e2",
  "red-200": "#fecaca",
  "red-300": "#fca5a5",
  "red-400": "#f87171",
  "red-500": "#ef4444",
  "red-600": "#dc2626",
  "red-700": "#b91c1c",
  "red-800": "#991b1b",
  "red-900": "#7f1d1d",
  "red-950": "#450a0a",
  "orange-50": "#fff7ed",
  "orange-100": "#ffedd5",
  "orange-200": "#fed7aa",
  "orange-300": "#fdba74",
  "orange-400": "#fb923c",
  "orange-500": "#f97316",
  "orange-600": "#ea580c",
  "orange-700": "#c2410c",
  "orange-800": "#9a3412",
  "orange-900": "#7c2d12",
  "orange-950": "#431407",
  "amber-50": "#fffbeb",
  "amber-100": "#fef3c7",
  "amber-200": "#fde68a",
  "amber-300": "#fcd34d",
  "amber-400": "#fbbf24",
  "amber-500": "#f59e0b",
  "amber-600": "#d97706",
  "amber-700": "#b45309",
  "amber-800": "#92400e",
  "amber-900": "#78350f",
  "amber-950": "#451a03",
  "yellow-50": "#fefce8",
  "yellow-100": "#fef9c3",
  "yellow-200": "#fef08a",
  "yellow-300": "#fde047",
  "yellow-400": "#facc15",
  "yellow-500": "#eab308",
  "yellow-600": "#ca8a04",
  "yellow-700": "#a16207",
  "yellow-800": "#854d0e",
  "yellow-900": "#713f12",
  "yellow-950": "#422006",
  "green-50": "#f0fdf4",
  "green-100": "#dcfce7",
  "green-200": "#bbf7d0",
  "green-300": "#86efac",
  "green-400": "#4ade80",
  "green-500": "#22c55e",
  "green-600": "#16a34a",
  "green-700": "#15803d",
  "green-800": "#166534",
  "green-900": "#14532d",
  "green-950": "#052e16",
  "emerald-50": "#ecfdf5",
  "emerald-100": "#d1fae5",
  "emerald-200": "#a7f3d0",
  "emerald-300": "#6ee7b7",
  "emerald-400": "#34d399",
  "emerald-500": "#10b981",
  "emerald-600": "#059669",
  "emerald-700": "#047857",
  "emerald-800": "#065f46",
  "emerald-900": "#064e3b",
  "emerald-950": "#022c22",
  "teal-50": "#f0fdfa",
  "teal-100": "#ccfbf1",
  "teal-200": "#99f6e4",
  "teal-300": "#5eead4",
  "teal-400": "#2dd4bf",
  "teal-500": "#14b8a6",
  "teal-600": "#0d9488",
  "teal-700": "#0f766e",
  "teal-800": "#115e59",
  "teal-900": "#134e4a",
  "teal-950": "#042f2e",
  "cyan-50": "#ecfeff",
  "cyan-100": "#cffafe",
  "cyan-200": "#a5f3fc",
  "cyan-300": "#67e8f9",
  "cyan-400": "#22d3ee",
  "cyan-500": "#06b6d4",
  "cyan-600": "#0891b2",
  "cyan-700": "#0e7490",
  "cyan-800": "#155e75",
  "cyan-900": "#164e63",
  "cyan-950": "#083344",
  "blue-50": "#eff6ff",
  "blue-100": "#dbeafe",
  "blue-200": "#bfdbfe",
  "blue-300": "#93c5fd",
  "blue-400": "#60a5fa",
  "blue-500": "#3b82f6",
  "blue-600": "#2563eb",
  "blue-700": "#1d4ed8",
  "blue-800": "#1e40af",
  "blue-900": "#1e3a8a",
  "blue-950": "#172554",
  "indigo-50": "#eef2ff",
  "indigo-100": "#e0e7ff",
  "indigo-200": "#c7d2fe",
  "indigo-300": "#a5b4fc",
  "indigo-400": "#818cf8",
  "indigo-500": "#6366f1",
  "indigo-600": "#4f46e5",
  "indigo-700": "#4338ca",
  "indigo-800": "#3730a3",
  "indigo-900": "#312e81",
  "indigo-950": "#1e1b4b",
  "violet-50": "#f5f3ff",
  "violet-100": "#ede9fe",
  "violet-200": "#ddd6fe",
  "violet-300": "#c4b5fd",
  "violet-400": "#a78bfa",
  "violet-500": "#8b5cf6",
  "violet-600": "#7c3aed",
  "violet-700": "#6d28d9",
  "violet-800": "#5b21b6",
  "violet-900": "#4c1d95",
  "violet-950": "#2e1065",
  "purple-50": "#faf5ff",
  "purple-100": "#f3e8ff",
  "purple-200": "#e9d5ff",
  "purple-300": "#d8b4fe",
  "purple-400": "#c084fc",
  "purple-500": "#a855f7",
  "purple-600": "#9333ea",
  "purple-700": "#7e22ce",
  "purple-800": "#6b21a8",
  "purple-900": "#581c87",
  "purple-950": "#3b0764",
  "pink-50": "#fdf2f8",
  "pink-100": "#fce7f3",
  "pink-200": "#fbcfe8",
  "pink-300": "#f9a8d4",
  "pink-400": "#f472b6",
  "pink-500": "#ec4899",
  "pink-600": "#db2777",
  "pink-700": "#be185d",
  "pink-800": "#9d174d",
  "pink-900": "#831843",
  "pink-950": "#500724",
  "rose-50": "#fff1f2",
  "rose-100": "#ffe4e6",
  "rose-200": "#fecdd3",
  "rose-300": "#fda4af",
  "rose-400": "#fb7185",
  "rose-500": "#f43f5e",
  "rose-600": "#e11d48",
  "rose-700": "#be123c",
  "rose-800": "#9f1239",
  "rose-900": "#881337",
  "rose-950": "#4c0519",
}

const STATIC_STYLES: Readonly<Record<string, StyleObject>> = {
  block: { display: "block" },
  "inline-block": { display: "inline-block" },
  inline: { display: "inline" },
  flex: { display: "flex" },
  "inline-flex": { display: "inline-flex" },
  grid: { display: "grid" },
  "inline-grid": { display: "inline-grid" },
  contents: { display: "contents" },
  "flow-root": { display: "flow-root" },
  hidden: { display: "none" },
  static: { position: "static" },
  fixed: { position: "fixed" },
  absolute: { position: "absolute" },
  relative: { position: "relative" },
  sticky: { position: "sticky" },
  "flex-row": { flexDirection: "row" },
  "flex-row-reverse": { flexDirection: "row-reverse" },
  "flex-col": { flexDirection: "column" },
  "flex-col-reverse": { flexDirection: "column-reverse" },
  "flex-wrap": { flexWrap: "wrap" },
  "flex-wrap-reverse": { flexWrap: "wrap-reverse" },
  "flex-nowrap": { flexWrap: "nowrap" },
  "flex-1": { flex: "1 1 0%" },
  "flex-auto": { flex: "1 1 auto" },
  "flex-initial": { flex: "0 1 auto" },
  "flex-none": { flex: "none" },
  grow: { flexGrow: 1 },
  "grow-0": { flexGrow: 0 },
  shrink: { flexShrink: 1 },
  "shrink-0": { flexShrink: 0 },
  "justify-normal": { justifyContent: "normal" },
  "justify-start": { justifyContent: "flex-start" },
  "justify-end": { justifyContent: "flex-end" },
  "justify-center": { justifyContent: "center" },
  "justify-between": { justifyContent: "space-between" },
  "justify-around": { justifyContent: "space-around" },
  "justify-evenly": { justifyContent: "space-evenly" },
  "justify-stretch": { justifyContent: "stretch" },
  "items-start": { alignItems: "flex-start" },
  "items-end": { alignItems: "flex-end" },
  "items-center": { alignItems: "center" },
  "items-baseline": { alignItems: "baseline" },
  "items-stretch": { alignItems: "stretch" },
  "self-auto": { alignSelf: "auto" },
  "self-start": { alignSelf: "flex-start" },
  "self-end": { alignSelf: "flex-end" },
  "self-center": { alignSelf: "center" },
  "self-stretch": { alignSelf: "stretch" },
  "place-items-start": { placeItems: "start" },
  "place-items-end": { placeItems: "end" },
  "place-items-center": { placeItems: "center" },
  "place-items-stretch": { placeItems: "stretch" },
  "place-content-start": { placeContent: "start" },
  "place-content-end": { placeContent: "end" },
  "place-content-center": { placeContent: "center" },
  "place-content-between": { placeContent: "space-between" },
  "place-content-around": { placeContent: "space-around" },
  "place-content-evenly": { placeContent: "space-evenly" },
  "place-content-stretch": { placeContent: "stretch" },
  "text-left": { textAlign: "left" },
  "text-center": { textAlign: "center" },
  "text-right": { textAlign: "right" },
  "text-justify": { textAlign: "justify" },
  "text-start": { textAlign: "start" },
  "text-end": { textAlign: "end" },
  italic: { fontStyle: "italic" },
  "not-italic": { fontStyle: "normal" },
  uppercase: { textTransform: "uppercase" },
  lowercase: { textTransform: "lowercase" },
  capitalize: { textTransform: "capitalize" },
  "normal-case": { textTransform: "none" },
  underline: { textDecorationLine: "underline" },
  overline: { textDecorationLine: "overline" },
  "line-through": { textDecorationLine: "line-through" },
  "no-underline": { textDecorationLine: "none" },
  "whitespace-normal": { whiteSpace: "normal" },
  "whitespace-nowrap": { whiteSpace: "nowrap" },
  "whitespace-pre": { whiteSpace: "pre" },
  "whitespace-pre-line": { whiteSpace: "pre-line" },
  "whitespace-pre-wrap": { whiteSpace: "pre-wrap" },
  "break-normal": { overflowWrap: "normal", wordBreak: "normal" },
  "break-words": { overflowWrap: "break-word" },
  "break-all": { wordBreak: "break-all" },
  truncate: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  "overflow-auto": { overflow: "auto" },
  "overflow-hidden": { overflow: "hidden" },
  "overflow-clip": { overflow: "clip" },
  "overflow-visible": { overflow: "visible" },
  "overflow-scroll": { overflow: "scroll" },
  "object-contain": { objectFit: "contain" },
  "object-cover": { objectFit: "cover" },
  "object-fill": { objectFit: "fill" },
  "object-none": { objectFit: "none" },
  "object-scale-down": { objectFit: "scale-down" },
  "bg-fixed": { backgroundAttachment: "fixed" },
  "bg-local": { backgroundAttachment: "local" },
  "bg-scroll": { backgroundAttachment: "scroll" },
  "bg-cover": { backgroundSize: "cover" },
  "bg-contain": { backgroundSize: "contain" },
  "bg-center": { backgroundPosition: "center" },
  "bg-top": { backgroundPosition: "top" },
  "bg-right": { backgroundPosition: "right" },
  "bg-bottom": { backgroundPosition: "bottom" },
  "bg-left": { backgroundPosition: "left" },
  "border-solid": { borderStyle: "solid" },
  "border-dashed": { borderStyle: "dashed" },
  "border-dotted": { borderStyle: "dotted" },
  "border-double": { borderStyle: "double" },
  "border-hidden": { borderStyle: "hidden" },
  "border-none": { borderStyle: "none" },
  "rounded-none": { borderRadius: "0px" },
  rounded: { borderRadius: "0.25rem" },
  "rounded-sm": { borderRadius: "0.125rem" },
  "rounded-md": { borderRadius: "0.375rem" },
  "rounded-lg": { borderRadius: "0.5rem" },
  "rounded-xl": { borderRadius: "0.75rem" },
  "rounded-2xl": { borderRadius: "1rem" },
  "rounded-3xl": { borderRadius: "1.5rem" },
  "rounded-full": { borderRadius: "9999px" },
  "shadow-sm": { boxShadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)" },
  shadow: { boxShadow: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)" },
  "shadow-md": { boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)" },
  "shadow-lg": { boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)" },
  "shadow-xl": { boxShadow: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)" },
  "shadow-2xl": { boxShadow: "0 25px 50px -12px rgb(0 0 0 / 0.25)" },
  "shadow-inner": { boxShadow: "inset 0 2px 4px 0 rgb(0 0 0 / 0.05)" },
  "shadow-none": { boxShadow: "0 0 #0000" },
  "transition-none": { transitionProperty: "none" },
  "transition-all": {
    transitionProperty: "all",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  "transition-colors": {
    transitionProperty:
      "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  "transition-opacity": {
    transitionProperty: "opacity",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  "transition-shadow": {
    transitionProperty: "box-shadow",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  "transition-transform": {
    transitionProperty: "transform",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transitionDuration: "150ms",
  },
  "cursor-auto": { cursor: "auto" },
  "cursor-default": { cursor: "default" },
  "cursor-pointer": { cursor: "pointer" },
  "cursor-wait": { cursor: "wait" },
  "cursor-text": { cursor: "text" },
  "cursor-move": { cursor: "move" },
  "cursor-not-allowed": { cursor: "not-allowed" },
  "select-none": { userSelect: "none" },
  "select-text": { userSelect: "text" },
  "select-all": { userSelect: "all" },
  "select-auto": { userSelect: "auto" },
  visible: { visibility: "visible" },
  invisible: { visibility: "hidden" },
  collapse: { visibility: "collapse" },
  "appearance-none": { appearance: "none" },
  "pointer-events-none": { pointerEvents: "none" },
  "pointer-events-auto": { pointerEvents: "auto" },
  "resize-none": { resize: "none" },
  "resize-y": { resize: "vertical" },
  "resize-x": { resize: "horizontal" },
  resize: { resize: "both" },
}

const FONT_SIZES: Readonly<Record<string, readonly [string, string]>> = {
  xs: ["0.75rem", "1rem"],
  sm: ["0.875rem", "1.25rem"],
  base: ["1rem", "1.5rem"],
  lg: ["1.125rem", "1.75rem"],
  xl: ["1.25rem", "1.75rem"],
  "2xl": ["1.5rem", "2rem"],
  "3xl": ["1.875rem", "2.25rem"],
  "4xl": ["2.25rem", "2.5rem"],
  "5xl": ["3rem", "1"],
  "6xl": ["3.75rem", "1"],
  "7xl": ["4.5rem", "1"],
  "8xl": ["6rem", "1"],
  "9xl": ["8rem", "1"],
}

const FONT_WEIGHTS: Readonly<Record<string, number>> = {
  thin: 100,
  extralight: 200,
  light: 300,
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
}

const LINE_HEIGHTS: Readonly<Record<string, string>> = {
  none: "1",
  tight: "1.25",
  snug: "1.375",
  normal: "1.5",
  relaxed: "1.625",
  loose: "2",
}

const MAX_WIDTHS: Readonly<Record<string, string>> = {
  none: "none",
  0: "0rem",
  xs: "20rem",
  sm: "24rem",
  md: "28rem",
  lg: "32rem",
  xl: "36rem",
  "2xl": "42rem",
  "3xl": "48rem",
  "4xl": "56rem",
  "5xl": "64rem",
  "6xl": "72rem",
  "7xl": "80rem",
  full: "100%",
  min: "min-content",
  max: "max-content",
  fit: "fit-content",
}

const PSEUDO_VARIANTS: Readonly<Record<string, string>> = {
  hover: ":hover",
  focus: ":focus",
  "focus-visible": ":focus-visible",
  active: ":active",
  visited: ":visited",
  target: ":target",
  enabled: ":enabled",
  disabled: ":disabled",
  checked: ":checked",
  indeterminate: ":indeterminate",
  default: ":default",
  required: ":required",
  valid: ":valid",
  invalid: ":invalid",
  placeholder: "::placeholder",
  "placeholder-shown": ":placeholder-shown",
  autofill: ":autofill",
  "read-only": ":read-only",
}

const CLASS_ATTRIBUTE =
  /\bclassName\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)')\s*\}|\{([\s\S]*?)\})/g

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const cloneStyle = (style: StyleObject): StyleObject => {
  const result: Record<string, string | number | StyleObject> = {}
  for (const [key, value] of Object.entries(style))
    result[key] = isRecord(value) ? cloneStyle(value as StyleObject) : (value as string | number)
  return result
}

const withVariants = (style: StyleObject, variants: readonly string[]): UtilityConversion => {
  let result = cloneStyle(style)
  for (const variant of [...variants].reverse()) {
    const breakpoint = BREAKPOINTS[variant]
    if (breakpoint !== undefined) {
      result = { [`@media (min-width: ${breakpoint})`]: result }
      continue
    }
    const pseudo = PSEUDO_VARIANTS[variant]
    if (pseudo !== undefined) {
      result = { [pseudo]: result }
      continue
    }
    if (variant === "motion-safe") {
      result = { "@media (prefers-reduced-motion: no-preference)": result }
      continue
    }
    if (variant === "motion-reduce") {
      result = { "@media (prefers-reduced-motion: reduce)": result }
      continue
    }
    return {
      reason: `variant '${variant}:' depends on parent state, arbitrary selectors, or runtime configuration`,
    }
  }
  return { style: result }
}

const negativeValue = (value: string | number, negative: boolean): string | number => {
  if (!negative) return value
  if (typeof value === "number") return -value
  if (value === "0") return 0
  return value.startsWith("-") ? value.slice(1) : `-${value}`
}

const spacingValue = (value: string, negative: boolean): string | number | undefined => {
  if (value === "auto") return negative ? undefined : "auto"
  const spacing = SPACING[value]
  return spacing === undefined ? undefined : negativeValue(spacing, negative)
}

const dimensionValue = (value: string, axis: "w" | "h"): string | number | undefined => {
  if (value === "auto") return "auto"
  if (value === "full") return "100%"
  if (value === "screen") return axis === "h" ? "100vh" : "100vw"
  if (value === "svw") return "100svw"
  if (value === "lvw") return "100lvw"
  if (value === "dvw") return "100dvw"
  if (value === "svh") return "100svh"
  if (value === "lvh") return "100lvh"
  if (value === "dvh") return "100dvh"
  if (value === "min") return "min-content"
  if (value === "max") return "max-content"
  if (value === "fit") return "fit-content"
  return FRACTIONS[value] ?? SPACING[value]
}

const colorValue = (value: string): string | undefined => COLORS[value]

const directionalProperty = (
  prefix: string,
  axis: string | undefined,
): readonly string[] | undefined => {
  const properties: Readonly<Record<string, readonly string[]>> = {
    p: ["padding"],
    px: ["paddingInline"],
    py: ["paddingBlock"],
    pt: ["paddingTop"],
    pr: ["paddingRight"],
    pb: ["paddingBottom"],
    pl: ["paddingLeft"],
    ps: ["paddingInlineStart"],
    pe: ["paddingInlineEnd"],
    m: ["margin"],
    mx: ["marginInline"],
    my: ["marginBlock"],
    mt: ["marginTop"],
    mr: ["marginRight"],
    mb: ["marginBottom"],
    ml: ["marginLeft"],
    ms: ["marginInlineStart"],
    me: ["marginInlineEnd"],
    inset: ["inset"],
    "inset-x": ["insetInline"],
    "inset-y": ["insetBlock"],
    start: ["insetInlineStart"],
    end: ["insetInlineEnd"],
    top: ["top"],
    right: ["right"],
    bottom: ["bottom"],
    left: ["left"],
  }
  if (axis === undefined) return properties[prefix]
  return properties[`${prefix}-${axis}`]
}

const convertBase = (token: string, negative: boolean): UtilityConversion => {
  const staticStyle = STATIC_STYLES[token]
  if (staticStyle !== undefined) {
    if (negative) return { reason: `negative utility '${token}' has no safe StyleX equivalent` }
    return { style: staticStyle }
  }

  const spacing =
    /^(p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|inset|start|end|top|right|bottom|left)(?:-(.+))$/.exec(
      token,
    )
  if (spacing !== null) {
    const value = spacingValue(spacing[2] as string, negative)
    const properties = directionalProperty(spacing[1] as string, undefined)
    if (value !== undefined && properties !== undefined) {
      return { style: Object.fromEntries(properties.map((property) => [property, value])) }
    }
    return { reason: `spacing value '${spacing[2]}' is not in the safe static scale` }
  }

  const gap = /^(gap|gap-x|gap-y)-(.+)$/.exec(token)
  if (gap !== null) {
    const value = spacingValue(gap[2] as string, negative)
    if (value !== undefined) {
      const property = gap[1] === "gap-x" ? "columnGap" : gap[1] === "gap-y" ? "rowGap" : "gap"
      return { style: { [property]: value } }
    }
    return { reason: `gap value '${gap[2]}' is not in the safe static scale` }
  }

  const size = /^(w|h|min-w|min-h|max-w|max-h)-(.+)$/.exec(token)
  if (size !== null) {
    const rawValue = size[2] as string
    const axis = size[1]?.endsWith("h") ? "h" : "w"
    const value = size[1] === "max-w" ? MAX_WIDTHS[rawValue] : dimensionValue(rawValue, axis)
    if (value !== undefined) {
      const property =
        size[1] === "w"
          ? "width"
          : size[1] === "h"
            ? "height"
            : size[1] === "min-w"
              ? "minWidth"
              : size[1] === "min-h"
                ? "minHeight"
                : size[1] === "max-w"
                  ? "maxWidth"
                  : "maxHeight"
      return { style: { [property]: negativeValue(value, negative) } }
    }
    return { reason: `size value '${rawValue}' is not in the safe static scale` }
  }

  const inset = /^(inset|inset-x|inset-y|start|end|top|right|bottom|left)-(.+)$/.exec(token)
  if (inset !== null) {
    const value = spacingValue(inset[2] as string, negative)
    const properties = directionalProperty(inset[1] as string, undefined)
    if (value !== undefined && properties !== undefined)
      return { style: Object.fromEntries(properties.map((property) => [property, value])) }
    return { reason: `inset value '${inset[2]}' is not in the safe static scale` }
  }

  const zIndex = /^z-(.+)$/.exec(token)
  if (zIndex !== null && (zIndex[1] === "auto" || /^\d+$/.test(zIndex[1] as string)))
    return { style: { zIndex: zIndex[1] === "auto" ? "auto" : Number(zIndex[1]) } }

  const order = /^order-(.+)$/.exec(token)
  if (order !== null) {
    const value = { first: -9999, last: 9999, none: 0 }[order[1] as "first" | "last" | "none"]
    if (value !== undefined) return { style: { order: value } }
    if (/^\d+$/.test(order[1] as string)) return { style: { order: Number(order[1]) } }
  }

  const textSize = /^text-(.+)$/.exec(token)
  if (textSize !== null) {
    const size = FONT_SIZES[textSize[1] as string]
    if (size !== undefined) return { style: { fontSize: size[0], lineHeight: size[1] } }
    const color = colorValue(textSize[1] as string)
    if (color !== undefined) return { style: { color } }
    return {
      reason: `text utility '${textSize[1]}' is not in the safe static typography/color set`,
    }
  }

  const background = /^bg-(.+)$/.exec(token)
  if (background !== null) {
    const color = colorValue(background[1] as string)
    if (color !== undefined) return { style: { backgroundColor: color } }
    return { reason: `background utility '${background[1]}' is not in the safe static color set` }
  }

  const font = /^font-(.+)$/.exec(token)
  if (font !== null) {
    const weight = FONT_WEIGHTS[font[1] as string]
    if (weight !== undefined) return { style: { fontWeight: weight } }
    if (font[1] === "sans") return { style: { fontFamily: "ui-sans-serif, system-ui, sans-serif" } }
    if (font[1] === "serif") return { style: { fontFamily: "ui-serif, Georgia, serif" } }
    if (font[1] === "mono")
      return { style: { fontFamily: "ui-monospace, SFMono-Regular, monospace" } }
    return { reason: `font utility '${font[1]}' is not in the safe static typography set` }
  }

  const leading = /^leading-(.+)$/.exec(token)
  if (leading !== null) {
    const value = LINE_HEIGHTS[leading[1] as string] ?? spacingValue(leading[1] as string, false)
    if (value !== undefined) return { style: { lineHeight: value } }
    return { reason: `line-height value '${leading[1]}' is not in the safe static scale` }
  }

  const tracking = /^tracking-(.+)$/.exec(token)
  if (tracking !== null) {
    const values: Readonly<Record<string, string>> = {
      tighter: "-0.05em",
      tight: "-0.025em",
      normal: "0em",
      wide: "0.025em",
      wider: "0.05em",
      widest: "0.1em",
    }
    const value = values[tracking[1] as string]
    if (value !== undefined) return { style: { letterSpacing: value } }
    return { reason: `letter-spacing value '${tracking[1]}' is not in the safe static set` }
  }

  const opacity = /^opacity-(\d+)$/.exec(token)
  if (opacity !== null && Number(opacity[1]) <= 100)
    return { style: { opacity: Number(opacity[1]) / 100 } }

  const borderWidth = /^(border(?:-[trblxyse])?)(?:-(0|2|4|8))?$/.exec(token)
  if (borderWidth !== null) {
    const value = borderWidth[2] === undefined ? "1px" : `${borderWidth[2]}px`
    const properties: Readonly<Record<string, string>> = {
      border: "borderWidth",
      "border-x": "borderInlineWidth",
      "border-y": "borderBlockWidth",
      "border-t": "borderTopWidth",
      "border-r": "borderRightWidth",
      "border-b": "borderBottomWidth",
      "border-l": "borderLeftWidth",
      "border-s": "borderInlineStartWidth",
      "border-e": "borderInlineEndWidth",
    }
    const property = properties[borderWidth[1] as string]
    if (property === undefined)
      return { reason: `border utility '${token}' has no safe StyleX property mapping` }
    return { style: { [property]: value } }
  }

  const borderColor = /^(border(?:-[trblxyse])?)-(.+)$/.exec(token)
  if (borderColor !== null) {
    const color = colorValue(borderColor[2] as string)
    if (color !== undefined) {
      const properties: Readonly<Record<string, string>> = {
        border: "borderColor",
        "border-x": "borderInlineColor",
        "border-y": "borderBlockColor",
        "border-t": "borderTopColor",
        "border-r": "borderRightColor",
        "border-b": "borderBottomColor",
        "border-l": "borderLeftColor",
        "border-s": "borderInlineStartColor",
        "border-e": "borderInlineEndColor",
      }
      const property = properties[borderColor[1] as string]
      if (property === undefined)
        return { reason: `border utility '${token}' has no safe StyleX property mapping` }
      return { style: { [property]: color } }
    }
    return { reason: `border color '${borderColor[2]}' is not in the safe static color set` }
  }

  const rounded = /^rounded(?:-([trblse]{1,2}))?(?:-(none|sm|md|lg|xl|2xl|3xl|full))?$/.exec(token)
  if (rounded !== null) {
    const sizes: Readonly<Record<string, string>> = {
      none: "0px",
      sm: "0.125rem",
      md: "0.375rem",
      lg: "0.5rem",
      xl: "0.75rem",
      "2xl": "1rem",
      "3xl": "1.5rem",
      full: "9999px",
    }
    const value = sizes[rounded[2] ?? "md"] ?? (rounded[2] === undefined ? "0.25rem" : undefined)
    if (value !== undefined) {
      const side = rounded[1]
      if (side === undefined) return { style: { borderRadius: value } }
      const properties: Readonly<Record<string, readonly string[]>> = {
        t: ["borderTopLeftRadius", "borderTopRightRadius"],
        r: ["borderTopRightRadius", "borderBottomRightRadius"],
        b: ["borderBottomLeftRadius", "borderBottomRightRadius"],
        l: ["borderTopLeftRadius", "borderBottomLeftRadius"],
        s: ["borderStartStartRadius", "borderEndStartRadius"],
        e: ["borderStartEndRadius", "borderEndEndRadius"],
      }
      const first = properties[side[0] as string]
      const second = properties[side[1] as string]
      if (first !== undefined && second !== undefined)
        return {
          style: Object.fromEntries([...first, ...second].map((property) => [property, value])),
        }
      if (first !== undefined)
        return { style: Object.fromEntries(first.map((property) => [property, value])) }
    }
  }

  return { reason: "utility is outside the safe static Tailwind-to-StyleX subset" }
}

const convertToken = (token: string): UtilityConversion => {
  const parts = token.split(":")
  const base = parts.pop() ?? ""
  const negative = base.startsWith("-")
  const normalized = negative ? base.slice(1) : base
  const conversion = convertBase(normalized, negative)
  if (conversion.style === undefined) return conversion
  return withVariants(conversion.style, parts)
}

const lineOf = (source: string, offset: number): number => {
  let line = 1
  for (let index = 0; index < offset; index += 1) if (source[index] === "\n") line += 1
  return line
}

const isLikelyJsxAttribute = (source: string, offset: number): boolean => {
  const tagStart = source.lastIndexOf("<", offset)
  const tagEnd = source.lastIndexOf(">", offset)
  return tagStart > tagEnd && !source.slice(tagStart, offset).includes("<!--")
}

const classAttributes = (source: string): readonly ClassAttribute[] => {
  const attributes: ClassAttribute[] = []
  for (const match of source.matchAll(CLASS_ATTRIBUTE)) {
    const start = match.index ?? 0
    if (!isLikelyJsxAttribute(source, start)) continue
    const end = start + match[0].length
    const value = match[1] ?? match[2] ?? match[3] ?? match[4]
    attributes.push(
      value === undefined ? { start, end, expression: match[5] ?? "" } : { start, end, value },
    )
  }
  return attributes
}

const safeIdentifier = (value: string): string => {
  const normalized = value.replace(/[^A-Za-z0-9_$]+/g, "_").replace(/^\d/, "_$&")
  return normalized.length === 0 ? "utility" : normalized
}

const uniqueIdentifier = (source: string, base: string): string => {
  const names = new Set(
    [...source.matchAll(/\b(?:const|let|var|function|class|import)\s+([A-Za-z_$][\w$]*)/g)].map(
      (match) => match[1],
    ),
  )
  let candidate = base
  let suffix = 2
  while (names.has(candidate)) candidate = `${base}${suffix++}`
  return candidate
}

const existingStylexImport = (source: string): string | undefined => {
  const match =
    /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["'](?:@stylexjs\/stylex|stylex)["']/.exec(
      source,
    )
  return match?.[1]
}

const insertionOffset = (source: string): number => {
  let offset = source.startsWith("#!") ? source.indexOf("\n") + 1 || source.length : 0
  const lines = source.slice(offset).split(/(?<=\n)/)
  let consumed = 0
  let inImport = false
  for (const line of lines) {
    const trimmed = line.trim()
    const directive = /^(['"])(?:use client|use server)\1;?$/.test(trimmed)
    if (inImport || trimmed.startsWith("import ") || trimmed.startsWith("import{")) {
      inImport = !/(?:from\s+["'][^"']+["']|import\s+["'][^"']+["'])\s*;?$/.test(trimmed)
      consumed += line.length
      continue
    }
    if (directive || trimmed === "") {
      consumed += line.length
      continue
    }
    break
  }
  offset += consumed
  return offset
}

/** Transform one source file. The returned source is unchanged when every match is unsupported. */
export function migrateTailwindSource(source: string, file: string): SourceMigration {
  const attributes = classAttributes(source)
  if (attributes.length === 0) return { source, changed: false, replacements: 0, issues: [] }

  const replacements: { start: number; end: number; text: string }[] = []
  const issues: MigrationIssue[] = []
  const styles = new Map<string, StyleObject>()
  const tokenToKey = new Map<string, string>()

  for (const attribute of attributes) {
    if (attribute.value === undefined) {
      issues.push({
        file,
        line: lineOf(source, attribute.start),
        token: attribute.expression?.trim() || "className expression",
        reason: "dynamic className expressions are left for a manual StyleX props composition",
      })
      continue
    }
    const tokens = attribute.value.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    const converted: { token: string; style: StyleObject }[] = []
    let unsupported = false
    for (const token of tokens) {
      const conversion = convertToken(token)
      if (conversion.style === undefined) {
        issues.push({
          file,
          line: lineOf(source, attribute.start),
          token,
          reason: conversion.reason ?? "utility could not be converted safely",
        })
        unsupported = true
      } else converted.push({ token, style: conversion.style })
    }
    if (unsupported) continue

    const refs: string[] = []
    for (const { token, style } of converted) {
      let key = tokenToKey.get(token)
      if (key === undefined) {
        const base = `tw_${safeIdentifier(token)}`
        key = base
        let suffix = 2
        while (styles.has(key)) key = `${base}_${suffix++}`
        tokenToKey.set(token, key)
        styles.set(key, style)
      }
      refs.push(`${stylesNamePlaceholder}.${key}`)
    }
    replacements.push({
      start: attribute.start,
      end: attribute.end,
      text: `{...${stylexNamePlaceholder}.props(${refs.join(", ")})}`,
    })
  }

  if (replacements.length === 0) return { source, changed: false, replacements: 0, issues }

  const stylexName = existingStylexImport(source) ?? uniqueIdentifier(source, "nifraStylex")
  const stylesName = uniqueIdentifier(source, "nifraStyles")
  const rewritten = [...replacements]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (current, replacement) =>
        `${current.slice(0, replacement.start)}${replacement.text
          .replaceAll(stylexNamePlaceholder, stylexName)
          .replaceAll(stylesNamePlaceholder, stylesName)}${current.slice(replacement.end)}`,
      source,
    )
  const needsImport = existingStylexImport(source) === undefined
  const generated = `${needsImport ? `import * as ${stylexName} from "${STYLEX_SPECIFIER}"\n\n` : ""}const ${stylesName} = ${stylexName}.create(${JSON.stringify(Object.fromEntries(styles), null, 2)})\n\n`
  const offset = insertionOffset(rewritten)
  const withGenerated = `${rewritten.slice(0, offset)}${generated}${rewritten.slice(offset)}`
  return { source: withGenerated, changed: true, replacements: replacements.length, issues }
}

const stylexNamePlaceholder = "__NIFRA_STYLEX__"
const stylesNamePlaceholder = "__NIFRA_STYLES__"
const STYLEX_SPECIFIER = "@stylexjs/" + "stylex"

async function sourceFiles(root: string): Promise<readonly string[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.isDirectory()) continue
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await visit(resolve(directory, entry.name))
        continue
      }
      if (entry.isFile() && SOURCE_FILE.test(entry.name)) files.push(resolve(directory, entry.name))
    }
  }
  await visit(root)
  return files.sort()
}

/** Scan a project and optionally write only the statically safe transformations. */
export async function migrateTailwindToStylex(
  root: string,
  options: StylexMigrationOptions = {},
): Promise<StylexMigrationResult> {
  const write = options.write === true
  const files: StylexMigrationFile[] = []
  const issues: MigrationIssue[] = []
  const changed: string[] = []
  const written: string[] = []
  const paths = await sourceFiles(root)
  for (const path of paths) {
    const file = relative(root, path).replaceAll("\\", "/")
    const source = await readFile(path, "utf8")
    const migration = migrateTailwindSource(source, file)
    if (!migration.changed && migration.issues.length === 0) continue
    const willWrite = write && migration.changed
    if (migration.changed) changed.push(file)
    if (willWrite) {
      await writeFile(path, migration.source, "utf8")
      written.push(file)
    }
    issues.push(...migration.issues)
    files.push({
      file,
      changed: migration.changed,
      replacements: migration.replacements,
      written: willWrite,
      issues: migration.issues,
    })
  }
  return {
    ok: issues.length === 0,
    from: "tailwind",
    to: "stylex",
    write,
    scanned: paths.length,
    changed,
    written,
    issues,
    files,
  }
}
