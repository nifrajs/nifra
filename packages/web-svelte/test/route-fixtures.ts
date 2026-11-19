// Route-table entries the hook tests read: "/test-loose" is the untyped read, "/test-paged" a typed one.
declare module "@nifrajs/web" {
  interface RouteTable {
    "/test-loose": {
      readonly params: Readonly<Record<string, string>>
      readonly search: Record<string, unknown>
    }
    "/test-paged": {
      readonly params: Record<string, never>
      readonly search: { readonly page: number }
    }
  }
}

export {}
