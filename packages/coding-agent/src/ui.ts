import { publicErrorMessage } from "./errors.ts"
import { isRecord } from "./internal/record.ts"

export type UiExtensionSlot = "sidebar" | "main" | "timeline" | "diff" | "workflow" | "status"

export interface UiThemeDescriptor {
  readonly name: string
  readonly accent?: string
  readonly density?: "compact" | "comfortable"
}

export interface UiStatusWidget {
  readonly text: string
  readonly tone?: "neutral" | "positive" | "warning" | "danger"
}

export interface UiExtensionManifest {
  readonly id: string
  readonly revision: string
  readonly slot: UiExtensionSlot
  readonly label: string
  readonly capabilities?: readonly string[]
  readonly theme?: UiThemeDescriptor
  readonly status?: UiStatusWidget
}

export interface UiExtensionHostOptions {
  readonly trustedCapabilities?: readonly string[]
  readonly maxExtensions?: number
}

export interface UiReloadResult {
  readonly revision: string
  readonly active: readonly UiExtensionManifest[]
  readonly rolledBack: boolean
  readonly error?: string
}

/** Data-only UI extension registry. The stable Workbench shell owns rendering and approval UX. */
export class UiExtensionHost {
  private readonly options: Required<Pick<UiExtensionHostOptions, "maxExtensions">> &
    UiExtensionHostOptions
  private active: readonly UiExtensionManifest[] = []
  private revision = "0"

  constructor(options: UiExtensionHostOptions = {}) {
    this.options = { ...options, maxExtensions: options.maxExtensions ?? 32 }
    if (!Number.isSafeInteger(this.options.maxExtensions) || this.options.maxExtensions < 1)
      throw new RangeError("ui extensions: maxExtensions must be positive")
  }

  get extensions(): readonly UiExtensionManifest[] {
    return this.active
  }
  get currentRevision(): string {
    return this.revision
  }

  /** Validate a candidate graph without changing the active shell-owned graph. */
  preview(manifests: readonly UiExtensionManifest[]): UiReloadResult {
    try {
      const active = validateManifests(manifests, this.options)
      return {
        revision: `preview:${this.revision}`,
        active,
        rolledBack: false,
      }
    } catch (error) {
      return {
        revision: this.revision,
        active: this.active,
        rolledBack: true,
        error: publicErrorMessage(error, "UI extension preview failed"),
      }
    }
  }

  reload(manifests: readonly UiExtensionManifest[]): UiReloadResult {
    try {
      const active = validateManifests(manifests, this.options)
      this.active = active
      this.revision = `${Date.now().toString(36)}-${this.active.length}`
      return { revision: this.revision, active: this.active, rolledBack: false }
    } catch (error) {
      return {
        revision: this.revision,
        active: this.active,
        rolledBack: true,
        error: publicErrorMessage(error, "UI extension reload failed"),
      }
    }
  }
}

const UI_SLOTS: ReadonlySet<unknown> = new Set([
  "sidebar",
  "main",
  "timeline",
  "diff",
  "workflow",
  "status",
])
const UI_TONES: ReadonlySet<unknown> = new Set(["neutral", "positive", "warning", "danger"])
const UI_DENSITIES: ReadonlySet<unknown> = new Set(["compact", "comfortable"])

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const matches = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.test(value)
const isSlot = (value: unknown): value is UiExtensionSlot => UI_SLOTS.has(value)
const isTone = (value: unknown): value is NonNullable<UiStatusWidget["tone"]> => UI_TONES.has(value)
const isDensity = (value: unknown): value is NonNullable<UiThemeDescriptor["density"]> =>
  UI_DENSITIES.has(value)

// Manifests come from extension code, often parsed JSON: every field is type-checked, and only the
// known fields are copied into the frozen result.
function validateManifests(
  manifests: unknown,
  options: UiExtensionHostOptions & { readonly maxExtensions: number },
): readonly UiExtensionManifest[] {
  if (!Array.isArray(manifests)) throw new Error("UI extension manifests must be an array")
  if (manifests.length > options.maxExtensions) throw new Error("ui extension limit exceeded")
  const trusted = new Set(options.trustedCapabilities ?? [])
  const ids = new Set<string>()
  return Object.freeze(
    manifests.map((manifest: unknown): UiExtensionManifest => {
      if (!isRecord(manifest) || !matches(/^[a-z][a-z0-9._:-]{0,63}$/, manifest.id))
        throw new Error("invalid UI extension id")
      const id = manifest.id
      const revision = manifest.revision
      if (!matches(/^[a-zA-Z0-9._:-]{1,64}$/, revision))
        throw new Error(`invalid UI extension revision: ${id}`)
      const slot = manifest.slot
      if (!isSlot(slot)) throw new Error(`invalid UI extension slot: ${id}`)
      const label = manifest.label
      if (typeof label !== "string" || label.length === 0 || label.length > 120)
        throw new Error(`invalid UI extension label: ${id}`)
      const capabilities = manifest.capabilities ?? []
      if (
        !Array.isArray(capabilities) ||
        !capabilities.every((capability): capability is string => typeof capability === "string")
      )
        throw new Error(`invalid UI extension capabilities: ${id}`)
      const result: Mutable<UiExtensionManifest> = {
        id,
        revision,
        slot,
        label,
        capabilities: Object.freeze([...capabilities]),
      }
      if (manifest.theme !== undefined) result.theme = uiTheme(manifest.theme, id)
      if (manifest.status !== undefined) result.status = uiStatus(manifest.status, id)
      if (ids.has(id)) throw new Error(`duplicate UI extension: ${id}`)
      ids.add(id)
      const denied = capabilities.find((capability) => !trusted.has(capability))
      if (denied !== undefined)
        throw new Error(`UI extension ${id} requires untrusted capability: ${denied}`)
      return Object.freeze(result)
    }),
  )
}

function uiTheme(value: unknown, id: string): UiThemeDescriptor {
  if (!isRecord(value) || !matches(/^[a-z][a-z0-9._-]{0,31}$/, value.name))
    throw new Error(`invalid UI theme: ${id}`)
  const theme: Mutable<UiThemeDescriptor> = { name: value.name }
  const { accent, density } = value
  if (accent !== undefined) {
    if (!matches(/^#[0-9a-fA-F]{6}$/, accent)) throw new Error(`invalid UI theme accent: ${id}`)
    theme.accent = accent
  }
  if (density !== undefined) {
    if (!isDensity(density)) throw new Error(`invalid UI theme density: ${id}`)
    theme.density = density
  }
  return Object.freeze(theme)
}

function uiStatus(value: unknown, id: string): UiStatusWidget {
  if (
    !isRecord(value) ||
    typeof value.text !== "string" ||
    value.text.length === 0 ||
    value.text.length > 160
  )
    throw new Error(`invalid UI status widget: ${id}`)
  const status: Mutable<UiStatusWidget> = { text: value.text }
  const tone = value.tone
  if (tone !== undefined) {
    if (!isTone(tone)) throw new Error(`invalid UI status tone: ${id}`)
    status.tone = tone
  }
  return Object.freeze(status)
}
