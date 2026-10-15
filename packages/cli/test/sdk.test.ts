import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { server } from "@nifrajs/core/server"
import { type OpenAPIDocument, toOpenAPI } from "@nifrajs/schema/openapi"
import { renderSdk, runSdk, SdkGenerationError } from "../src/sdk.ts"
import {
  createFixtureRoot,
  removeFixtureRoot,
  removeReleasedDirectory,
  writeAppFile,
} from "./fixture-root.ts"

const document = toOpenAPI(server().get("/users/:id", () => ({ ok: true }))) as OpenAPIDocument

describe("SDK generation", () => {
  // A fresh CI runner pays a cold start the first time it runs python3 (2-30 s) and compiles the
  // standard library the Go client imports (15-90 s). Neither is what these tests check, so both are
  // paid here, under a budget of their own, by loading each generated client once.
  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "nifra-sdk-warm-"))
    try {
      const warmups: Promise<number>[] = []
      if (Bun.which("python3") !== null) {
        await Bun.write(join(dir, "nifra_sdk.py"), renderSdk(document, "python"))
        const load = "import sys; sys.path.insert(0, sys.argv[1]); import py_compile, nifra_sdk"
        warmups.push(
          Bun.spawn(["python3", "-c", load, dir], { stdout: "ignore", stderr: "ignore" }).exited,
        )
      }
      if (Bun.which("go") !== null) {
        await Bun.write(join(dir, "go.mod"), "module example.com/nifra-sdk\n\ngo 1.22\n")
        await Bun.write(join(dir, "nifra_sdk.go"), renderSdk(document, "go"))
        warmups.push(
          Bun.spawn(["go", "build", "./..."], { cwd: dir, stdout: "ignore", stderr: "ignore" })
            .exited,
        )
      }
      await Promise.all(warmups)
    } finally {
      await removeReleasedDirectory(dir)
    }
  }, 300_000)

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

  test("emits operations in code-unit order, the same in every locale", () => {
    const app = server()
      .get("/a_y", () => 1)
      .get("/B", () => 1)
      .get("/a-x", () => 1)
      .get("/a", () => 1)
    const ordered: OpenAPIDocument = toOpenAPI(app)
    const names = renderSdk(ordered, "python")
      .split("\n")
      .flatMap((line) => /def (get_\w+)\(/.exec(line)?.slice(1) ?? [])
    expect(names).toEqual(["get_B", "get_a", "get_a_x", "get_a_y"])
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
  }, 30_000)

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
      expect(output.trim().split(/\r?\n/)).toEqual([
        ".. refused",
        ". refused",
        "... sent",
        "a.b sent",
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    // Windows takes about two seconds to report each refused connection.
  }, 30_000)

  test("a Python model whose optional fields come first still imports and decodes", async () => {
    const userFirst: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/user": {
          get: {
            operationId: "getUser",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/User" } },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          User: {
            type: "object",
            properties: {
              nickname: { type: "string" },
              "display-name": { type: "string" },
              id: { type: "string" },
              "user-age": { type: "integer" },
            },
            required: ["id", "user-age"],
          },
        },
      },
    }
    const dir = await mkdtemp(join(tmpdir(), "nifra-sdk-"))
    try {
      await Bun.write(join(dir, "nifra_sdk.py"), renderSdk(userFirst, "python"))
      const script = [
        "import sys",
        "sys.path.insert(0, sys.argv[1])",
        "import nifra_sdk",
        "print(nifra_sdk._decode({'id': 'u1', 'user-age': 3, 'display-name': 'D'}, nifra_sdk.User))",
      ].join("\n")
      const process = Bun.spawn(["python3", "-c", script, dir], { stdout: "pipe", stderr: "pipe" })
      const [exitCode, output, errors] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ])
      expect(errors).toBe("")
      expect(exitCode).toBe(0)
      expect(output.trim()).toBe("User(id='u1', user_age=3, nickname=None, display_name='D')")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test("a Python alias may name a model declared after it, and aliases decode", async () => {
    const aliased: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/users": {
          get: {
            operationId: "getUsers",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Users" } },
                },
              },
              "404": {
                description: "missing",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { reason: { type: "string" } },
                      required: ["reason"],
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Users: {
            type: "array",
            items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          },
        },
      },
    }
    const dir = await mkdtemp(join(tmpdir(), "nifra-sdk-"))
    try {
      await Bun.write(join(dir, "nifra_sdk.py"), renderSdk(aliased, "python"))
      const script = [
        "import sys",
        "sys.path.insert(0, sys.argv[1])",
        "import nifra_sdk",
        "print(nifra_sdk._decode([{'id': 'u1'}], nifra_sdk.Users))",
        "print(nifra_sdk._decode({'reason': 'gone'}, nifra_sdk.GetUsersError))",
      ].join("\n")
      const process = Bun.spawn(["python3", "-c", script, dir], { stdout: "pipe", stderr: "pipe" })
      const [exitCode, output, errors] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ])
      expect(errors).toBe("")
      expect(exitCode).toBe(0)
      expect(output.trim().split(/\r?\n/)).toEqual([
        "[UsersItem(id='u1')]",
        "GetUsersError404(reason='gone')",
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test("generated Go refuses a path parameter that is a dot segment", () => {
    expect(renderSdk(document, "go")).toContain('if segment == "." || segment == ".."')
  })

  if (Bun.which("go") !== null) {
    // A cold Go cache takes about 15 s on a Linux runner. The test's timeout sits past the build's own
    // deadline, so a slow build is killed and its directory removed here rather than by the runner
    // while `go` still holds it.
    const goBuildDeadline = process.platform === "win32" ? 90_000 : 30_000
    const goCompileTimeout = goBuildDeadline + 15_000

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
            timeout: goBuildDeadline,
          })
          const stderr = goProcess.stderr
            ? new Response(goProcess.stderr).text()
            : Promise.resolve("")
          const [exitCode, errorOutput] = await Promise.all([goProcess.exited, stderr])
          if (goProcess.signalCode !== null) {
            throw new Error(`go build did not finish within ${goBuildDeadline} ms`)
          }
          if (exitCode !== 0) {
            throw new Error(
              `go build failed with exit code ${exitCode}${errorOutput.trim() ? `: ${errorOutput.trim()}` : ""}`,
            )
          }
        } finally {
          await removeReleasedDirectory(dir)
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
