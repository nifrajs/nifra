// The routes of this fixture app, as `nifra types` would put them in the route table.
declare module "@nifrajs/web" {
  interface RouteTable {
    "/detail/:id": { readonly params: { readonly id: string } }
    "/shop/:item": { readonly params: { readonly item: string } }
    "/list/:id": { readonly params: { readonly id: string } }
  }
}

export {}
