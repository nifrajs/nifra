export type HttpMemoryRuntime = "node" | "bun" | "deno"
export type HttpMemoryProtocol =
  | "fresh-native-node-v1"
  | "fresh-native-bun-v1"
  | "fresh-native-deno-v1"

export interface HttpMemoryRow {
  readonly name: string
  readonly version: string
  readonly nifra?: boolean
  readonly readyRssMiB: number
  readonly getRssMiB: number
  readonly postRssMiB: number
  readonly postHeapMiB: number
  readonly peakRssMiB: number
  readonly postRssMinMiB: number
  readonly postRssMaxMiB: number
}

export interface HttpMemoryCapture {
  readonly runtime: HttpMemoryRuntime
  readonly runtimeVersion: string
  /** Node version running the capture harness. */
  readonly node: string
  readonly date: string
  readonly platform: string
  readonly cpu: string
  readonly revision: string
  readonly workspaceArtifactSHA256: string
  readonly protocol: HttpMemoryProtocol
  readonly rounds: number
  readonly requestsPerPhase: number
  readonly connections: number
  readonly rows: readonly HttpMemoryRow[]
}
