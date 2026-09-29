import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { server } from "@nifrajs/core/server"
import { type OpenAPIDocument, toOpenAPI } from "@nifrajs/schema/openapi"
import { renderSdk, SdkGenerationError } from "../src/sdk.ts"

const document = toOpenAPI(server().get("/users/:id", () => ({ ok: true }))) as OpenAPIDocument

describe("SDK generation", () => {
  test("renders a usable standard-library Python client", () => {
    const source = renderSdk(document, "python")
    expect(source).toContain("class Client:")
    expect(source).toContain("def get_users_id(self, id: str")
    expect(source).toContain("urllib.request.urlopen")
  })

  test("renders a usable net/http Go client", () => {
    const source = renderSdk(document, "go")
    expect(source).toContain("package nifrasdk")
    expect(source).toContain("func (c *Client) GetUsersId(")
    expect(source).toContain("http.DefaultClient")
  })

  test("renders typed models, query structs, and typed error bodies", () => {
    const typed = {
      openapi: "3.1.0",
      info: { title: "typed", version: "1.0.0" },
      components: {
        schemas: {
          User: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "integer" }, name: { type: "string" } },
          },
          Missing: {
            type: "object",
            required: ["code"],
            properties: { code: { type: "string" } },
          },
        },
      },
      paths: {
        "/users/{id}": {
          get: {
            operationId: "getUser",
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string" } },
              { name: "include", in: "query", required: false, schema: { type: "boolean" } },
            ],
            responses: {
              "200": {
                description: "OK",
                content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
              },
              "404": {
                description: "Not Found",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Missing" } },
                },
              },
            },
          },
        },
      },
    } as unknown as OpenAPIDocument

    const python = renderSdk(typed, "python")
    expect(python).toContain("@dataclass(frozen=True)")
    expect(python).toContain("class User:")
    expect(python).toContain("type GetUserError = Missing")
    expect(python).toContain("include: bool | None = None")

    const go = renderSdk(typed, "go")
    expect(go).toContain("type User struct")
    expect(go).toContain("type GetUserQuery struct")
    expect(go).toContain("type GetUserError struct")
  })

  test("strict generation fails closed on an opaque response", () => {
    expect(() => renderSdk(document, "python", { strict: true })).toThrow(SdkGenerationError)
    expect(() => renderSdk(document, "go", { strict: true })).toThrow(/response 200/)
  })

  test("generated Python is syntactically compilable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-sdk-"))
    try {
      const path = join(dir, "nifra_sdk.py")
      await Bun.write(path, renderSdk(document, "python"))
      const process = Bun.spawn(["python3", "-m", "py_compile", path], {
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(await process.exited).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  if (Bun.which("go") !== null) {
    const goCompileTimeout = process.platform === "win32" ? 90_000 : 30_000

    test(
      "generated Go compiles with the standard library",
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "nifra-sdk-"))
        try {
          await Bun.write(join(dir, "go.mod"), "module example.com/nifra-sdk\n\ngo 1.22\n")
          await Bun.write(join(dir, "nifra_sdk.go"), renderSdk(document, "go"))
          const goProcess = Bun.spawn(["go", "build", "./..."], {
            cwd: dir,
            stdout: "ignore",
            stderr: "pipe",
          })
          const stderr = goProcess.stderr
            ? new Response(goProcess.stderr).text()
            : Promise.resolve("")
          const [exitCode, errorOutput] = await Promise.all([goProcess.exited, stderr])
          if (exitCode !== 0) {
            throw new Error(
              `go build failed with exit code ${exitCode}${errorOutput.trim() ? `: ${errorOutput.trim()}` : ""}`,
            )
          }
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      },
      { timeout: goCompileTimeout },
    )
  }
})
