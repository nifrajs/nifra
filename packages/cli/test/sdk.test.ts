import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { server } from "@nifrajs/core/server"
import { type OpenAPIDocument, toOpenAPI } from "@nifrajs/schema/openapi"
import { renderSdk, runSdk, SdkGenerationError } from "../src/sdk.ts"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

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

  test("a property name with no Go struct-tag spelling is reported, never written raw", () => {
    const evil =
      'id"`\n}\n\nfunc init() { panic("injected") }\n\ntype Pad struct {\n\tX string `json:"x'
    const object = {
      type: "object",
      properties: { [evil]: { type: "string" }, "-": { type: "string" }, name: { type: "string" } },
      required: [evil, "-", "name"],
    }
    const withKeys = {
      openapi: "3.1.0",
      info: { title: "keys", version: "1.0.0" },
      paths: {
        "/item": {
          get: {
            operationId: "getItem",
            responses: {
              "200": { description: "ok", content: { "application/json": { schema: object } } },
            },
          },
        },
      },
    } satisfies OpenAPIDocument
    const go = renderSdk(withKeys, "go")
    expect(go).not.toContain("injected")
    expect(go).toContain('`json:"-,"`')
    expect(go).toContain('`json:"name"`')
    expect(() => renderSdk(withKeys, "go", { strict: true })).toThrow(/Go struct tag/)
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

  test("generated Python refuses a path parameter that is a dot segment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-sdk-"))
    try {
      await Bun.write(join(dir, "nifra_sdk.py"), renderSdk(document, "python"))
      // The base URL is unreachable: a refused call never gets as far as the network, and a sent
      // one fails with a connection error instead.
      const script = [
        "import sys, urllib.error",
        "sys.path.insert(0, sys.argv[1])",
        "import nifra_sdk",
        'api = nifra_sdk.Client("http://127.0.0.1:1", timeout=2)',
        'for value in ("..", ".", "...", "a.b"):',
        "    try:",
        "        api.get_users_id(value)",
        '        print(value, "answered")',
        "    except ValueError:",
        '        print(value, "refused")',
        "    except urllib.error.URLError:",
        '        print(value, "sent")',
      ].join("\n")
      const process = Bun.spawn(["python3", "-c", script, dir], { stdout: "pipe", stderr: "pipe" })
      const [exitCode, output] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
      ])
      expect(exitCode).toBe(0)
      expect(output.trim().split("\n")).toEqual([".. refused", ". refused", "... sent", "a.b sent"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("generated Go refuses a path parameter that is a dot segment", () => {
    expect(renderSdk(document, "go")).toContain('if segment == "." || segment == ".."')
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

test("runSdk reads a real backend from backend/app.ts and writes the client", async () => {
  const root = createFixtureRoot("tmp-sdk-run-")
  try {
    writeAppFile(
      root,
      "backend/app.ts",
      'import { server } from "@nifrajs/core/server"\nexport const backend = server().get("/ping", () => ({ ok: true }))\n',
    )
    await runSdk(root, { language: "python" })
    expect(await Bun.file(join(root, "nifra_sdk.py")).text()).toContain("/ping")
  } finally {
    removeFixtureRoot(root)
  }
})
