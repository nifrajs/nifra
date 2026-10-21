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
  readonly date: string
  readonly node: string
  readonly platform: string
  readonly cpu: string
  readonly revision: string
  readonly workspaceArtifactSHA256: string
  readonly protocol: "fresh-native-node-v1"
  readonly rounds: number
  readonly requestsPerPhase: number
  readonly connections: number
  readonly rows: readonly HttpMemoryRow[]
}
