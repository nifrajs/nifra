/**
 * The framework-free half of a server component's outlet in a React or Preact page: the shell its host
 * renders once, and the mount, adoption and teardown of the instance inside that shell. The adapter
 * keeps the outlet's latest props in a ref and runs these from its layout effects.
 */
import {
  type ComponentClientAdapter,
  ComponentController,
  type ComponentRecord,
  type ComponentState,
} from "../server-components/client.ts"

/** What an outlet mounts with, read from its latest render whenever it is used. */
export interface OutletProps {
  readonly state: ComponentState
  readonly controller?: ComponentController | undefined
  readonly clientAdapter?: ComponentClientAdapter | undefined
  readonly onError?: ((code: string) => void) | undefined
}

/** How an adapter's framework runs its outlets. */
export interface OutletFramework {
  /** The adapter a controller the outlet makes uses when the page passes none. */
  readonly clientAdapter?: () => ComponentClientAdapter
  /**
   * The framework cleans up a hidden kept page's effects (React's `<Activity>`), so a teardown of an
   * instance the page's controller parked leaves it to that page.
   */
  readonly hidingCleansUp?: boolean
}

/** An outlet's instance once mounted. */
export interface MountedOutlet {
  /** Hand the controller the page's component state as it changes. */
  readonly adopt: (state: ComponentState) => void
  /** Unmount the instance from the page's controller, or dispose the controller the outlet made. */
  readonly teardown: () => void
}

/** The host's HTML, set once: the record's server-rendered range. */
export function outletHtml(record: ComponentRecord): { readonly __html: string } {
  return {
    __html: `<nifra-component data-nifra-component="${record.instance}">${record.html}</nifra-component>`,
  }
}

/**
 * Mount `instance` in the `<nifra-component>` the outlet's `host` holds. A failure reaches the page's
 * controller and the outlet's own `onError` alike; a host without that element reports
 * `component_contract`, and an outlet with neither a controller nor an adapter throws it.
 */
export function mountOutlet(
  latest: { readonly current: OutletProps },
  host: Element | null | undefined,
  instance: string,
  framework: OutletFramework = {},
): MountedOutlet | undefined {
  const props = latest.current
  const external = props.controller
  const adapter =
    external === undefined ? (props.clientAdapter ?? framework.clientAdapter?.()) : undefined
  if (external === undefined && adapter === undefined) throw new Error("component_contract")
  // A controller the outlet makes reports through here too, so its errors reach `onError` once.
  const report = (code: string): void => {
    external?.reportError(code)
    latest.current.onError?.(code)
  }
  if (host?.localName !== "nifra-component") {
    report("component_contract")
    return undefined
  }
  const controller =
    external ??
    new ComponentController({
      state: props.state,
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: without a page controller there is an adapter, by the check above
      adapter: adapter as ComponentClientAdapter,
      onError: report,
    })
  void controller.mount(host, instance).catch(() => report("component_failed"))
  return {
    adopt: (state) => {
      void controller.adopt(state).catch(() => report("component_failed"))
    },
    teardown: () => {
      if (framework.hidingCleansUp === true && external?.isParked(instance, host) === true) return
      void (
        external === undefined ? controller.dispose() : controller.unmount(instance, host)
      ).catch(() => report("component_failed"))
    },
  }
}
