import { sessionUser } from "../shell-lib/session.ts"

export const shellLoader = async () => ({ title: "shared" })

export const boundaryLoaders = {
  greeting: {
    load: () => ({ user: sessionUser(new Request("https://x.test")) }),
    revalidate: 30,
  },
}
