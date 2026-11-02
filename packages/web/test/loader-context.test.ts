import { expect, test } from "bun:test"
import {
  forkLoaderContext,
  markLoaderContextWithLazyRequestAccessors,
} from "../src/internal/loader-context.ts"

test("ordinary loader contexts use the shallow-copy path", () => {
  const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
  let descriptorCopies = 0
  const context = { request: "request", req: "request", search: "" }
  const fork = (() => {
    try {
      Object.getOwnPropertyDescriptors = ((target: object) => {
        descriptorCopies++
        return getOwnPropertyDescriptors(target)
      }) as typeof Object.getOwnPropertyDescriptors
      return forkLoaderContext(context, { search: "?page=1" })
    } finally {
      Object.getOwnPropertyDescriptors = getOwnPropertyDescriptors
    }
  })()

  expect(fork).not.toBe(context)
  expect(fork.search).toBe("?page=1")
  expect(fork.request).toBe(context.request)
  expect(descriptorCopies).toBe(0)
})

test("lazy request accessors stay lazy across loader-context forks", () => {
  let reads = 0
  const request = new Request("https://fixture.test/")
  const context = Object.defineProperties(
    { search: "" },
    {
      request: {
        configurable: true,
        enumerable: true,
        get: () => {
          reads++
          return request
        },
      },
      req: {
        configurable: true,
        enumerable: true,
        get: () => {
          reads++
          return request
        },
      },
    },
  ) as { request: Request; req: Request; search: string }
  markLoaderContextWithLazyRequestAccessors(context)

  const fork = forkLoaderContext(context, { search: "?page=1" })
  const nestedFork = forkLoaderContext(fork, { search: "?page=2" })

  expect(reads).toBe(0)
  expect(Object.getOwnPropertyDescriptor(nestedFork, "request")?.get).toBeDefined()
  expect(nestedFork.search).toBe("?page=2")
  expect(nestedFork.request).toBe(request)
  expect(reads).toBe(1)
})
