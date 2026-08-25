import { publicErrorMessage } from "./errors.ts"

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

function validateManifests(
  manifests: readonly UiExtensionManifest[],
  options: UiExtensionHostOptions & { readonly maxExtensions: number },
): readonly UiExtensionManifest[] {
  if (manifests.length > options.maxExtensions) throw new Error("ui extension limit exceeded")
  const trusted = new Set(options.trustedCapabilities ?? [])
  const ids = new Set<string>()
  return Object.freeze(
    manifests.map((manifest) => {
      if (!/^[a-z][a-z0-9._:-]{0,63}$/.test(manifest.id))
        throw new Error(`invalid UI extension id: ${manifest.id}`)
      if (!/^[a-zA-Z0-9._:-]{1,64}$/.test(manifest.revision))
        throw new Error(`invalid UI extension revision: ${manifest.id}`)
      if (!manifest.label || manifest.label.length > 120)
        throw new Error(`invalid UI extension label: ${manifest.id}`)
      if (manifest.theme !== undefined) {
        if (!/^[a-z][a-z0-9._-]{0,31}$/.test(manifest.theme.name))
          throw new Error(`invalid UI theme: ${manifest.id}`)
        if (manifest.theme.accent !== undefined && !/^#[0-9a-fA-F]{6}$/.test(manifest.theme.accent))
          throw new Error(`invalid UI theme accent: ${manifest.id}`)
      }
      if (manifest.status !== undefined) {
        if (!manifest.status.text || manifest.status.text.length > 160)
          throw new Error(`invalid UI status widget: ${manifest.id}`)
        if (
          manifest.status.tone !== undefined &&
          !["neutral", "positive", "warning", "danger"].includes(manifest.status.tone)
        )
          throw new Error(`invalid UI status tone: ${manifest.id}`)
      }
      if (ids.has(manifest.id)) throw new Error(`duplicate UI extension: ${manifest.id}`)
      ids.add(manifest.id)
      const denied = (manifest.capabilities ?? []).find((capability) => !trusted.has(capability))
      if (denied !== undefined)
        throw new Error(`UI extension ${manifest.id} requires untrusted capability: ${denied}`)
      return Object.freeze({
        ...manifest,
        capabilities: Object.freeze([...(manifest.capabilities ?? [])]),
        ...(manifest.theme === undefined ? {} : { theme: Object.freeze({ ...manifest.theme }) }),
        ...(manifest.status === undefined ? {} : { status: Object.freeze({ ...manifest.status }) }),
      })
    }),
  )
}
