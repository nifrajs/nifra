import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core/server"
import { type OpenAPIDocument, toOpenAPI } from "@nifrajs/schema/openapi"
import { renderSdk } from "../src/sdk.ts"

const document = toOpenAPI(server().get("/users/:id", () => ({ ok: true }))) as OpenAPIDocument

describe("SDK generation", () => {
  test("renders a usable standard-library Python client", () => {
    const source = renderSdk(document, "python")
    expect(source).toContain("class Client:")
    expect(source).toContain("def get_users_id(self, id: Any")
    expect(source).toContain("urllib.request.urlopen")
  })

  test("renders a usable net/http Go client", () => {
    const source = renderSdk(document, "go")
    expect(source).toContain("package nifrasdk")
    expect(source).toContain("func (c *Client) Get_users_id(")
    expect(source).toContain("http.DefaultClient")
  })
})
