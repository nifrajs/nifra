import { describe, expect, test } from "bun:test"
import ts from "typescript"
import { getSourceRewrite } from "../src/source-rewrites.ts"

function run(id: string, file: string, text: string) {
  const rewrite = getSourceRewrite(id)
  if (rewrite === undefined) throw new Error(`the ${id} rewrite is registered`)
  return rewrite.rewrite(ts, file, text)
}

describe("route-hooks rewrite", () => {
  const page = (body: string, from = "@nifrajs/web-react/router") =>
    `import { useParams, useSearch } from "${from}"\nexport default function Page() {\n  ${body}\n}\n`

  test("every legacy form in a page file names the page's own route", () => {
    const result = run(
      "route-hooks",
      "routes/users/[id].tsx",
      page(
        "const a = useParams(); const b = useParams<{ id: string }>(); const c = useSearch<typeof searchSchema>().tab",
      ),
    )
    expect(result.text).toBe(
      page(
        'const a = useParams("/users/:id"); const b = useParams("/users/:id"); const c = useSearch("/users/:id").tab',
      ),
    )
    expect(result.count).toBe(3)
    expect(result.manual).toEqual([])
  })

  test("a route in a monorepo app folder, an index page and a route group resolve", () => {
    expect(run("route-hooks", "apps/web/routes/index.tsx", page("useSearch()")).text).toContain(
      'useSearch("/")',
    )
    expect(run("route-hooks", "routes/(shop)/cart.tsx", page("useSearch()")).text).toContain(
      'useSearch("/cart")',
    )
  })

  test("single-quoted files keep their quote; an aliased import is followed", () => {
    const result = run(
      "route-hooks",
      "routes/a.tsx",
      "import { useSearch as search } from '@nifrajs/web-solid/router'\nexport default () => search().q\n",
    )
    expect(result.text).toBe(
      "import { useSearch as search } from '@nifrajs/web-solid/router'\nexport default () => search('/a').q\n",
    )
  })

  test("a call that already names its route is left alone, so a second run changes nothing", () => {
    const text = page('useSearch("/users/:id")', "@nifrajs/web-preact/router")
    const result = run("route-hooks", "routes/users/[id].tsx", text)
    expect(result.text).toBe(text)
    expect(result.count).toBe(0)
  })

  test("a shared component and a layout are listed, never guessed", () => {
    for (const file of ["frontend/components/Checkout.tsx", "routes/_layout.tsx"]) {
      const result = run("route-hooks", file, page("useSearch<typeof s>().sku"))
      expect(result.count).toBe(0)
      expect(result.text).toBe(page("useSearch<typeof s>().sku"))
      expect(result.manual).toHaveLength(1)
      expect(result.manual[0]?.line).toBe(3)
      expect(result.manual[0]?.reason).toContain("name the route it renders in")
    }
  })

  test("a hook from another router is not touched", () => {
    const text = `import { useParams } from "react-router"\nexport const a = () => useParams()\n`
    expect(run("route-hooks", "routes/a.tsx", text)).toEqual({ text, count: 0, manual: [] })
  })

  test(".svelte and .vue files are listed with the call to write", () => {
    const result = run(
      "route-hooks",
      "routes/users/[id].svelte",
      '<script lang="ts">\n  import { useParams } from "@nifrajs/web-svelte/router"\n  const params = useParams<{ id: string }>()\n</script>\n',
    )
    expect(result.count).toBe(0)
    expect(result.manual).toEqual([
      {
        line: 3,
        reason: 'useParams<{ id: string }>() takes the route: write useParams("/users/:id")',
      },
    ])
  })
})

describe("query-keys rewrite", () => {
  const withClient = (body: string) =>
    `import { useQueryClient } from "@nifrajs/web-react/query"\nexport const f = (qc: ReturnType<typeof useQueryClient>) => {\n  ${body}\n}\n`

  test("plain keys are wrapped, a type argument moves onto the key, and queryKey is imported", () => {
    const result = run(
      "query-keys",
      "data/saved.ts",
      withClient("qc.setQueryData(KEY, 1); const x = qc.getQueryData<number[]>(KEY2)"),
    )
    expect(result.text).toBe(
      `import { useQueryClient } from "@nifrajs/web-react/query"
import { queryKey } from "@nifrajs/web/client"
export const f = (qc: ReturnType<typeof useQueryClient>) => {
  qc.setQueryData(queryKey(KEY), 1); const x = qc.getQueryData(queryKey<number[]>(KEY2))
}
`,
    )
    expect(result.count).toBe(2)
  })

  test("an existing queryKey import is reused and a keyed call stays", () => {
    const text = `import { queryKey } from "@nifrajs/web"\nimport { useQueryClient } from "@nifrajs/web-react/query"\nexport const f = (qc: ReturnType<typeof useQueryClient>) => {\n  qc.setQueryData(queryKey(["a"]), 1)\n  qc.setQueryData(["b"], 2)\n}\n`
    const result = run("query-keys", "a.ts", text)
    expect(result.text).toBe(
      text.replace('qc.setQueryData(["b"], 2)', 'qc.setQueryData(queryKey(["b"]), 2)'),
    )
    expect(result.count).toBe(1)
  })

  test("a read inside another key is wrapped too, in as many passes as the nesting takes", () => {
    const result = run(
      "query-keys",
      "data/nested.ts",
      withClient(
        'const x = qc.getQueryData(["detail", qc.getQueryData<string>(["selected", qc.getQueryData(["deep"])])])',
      ),
    )
    expect(result.text).toBe(
      `import { useQueryClient } from "@nifrajs/web-react/query"
import { queryKey } from "@nifrajs/web/client"
export const f = (qc: ReturnType<typeof useQueryClient>) => {
  const x = qc.getQueryData(queryKey(["detail", qc.getQueryData(queryKey<string>(["selected", qc.getQueryData(queryKey(["deep"]))]))]))
}
`,
    )
    expect(result.count).toBe(3)
  })

  test("a file that already has a queryKey of its own gets the helper under another name", () => {
    const result = run(
      "query-keys",
      "data/clash.ts",
      `import { useQueryClient } from "@nifrajs/web-react/query"\nconst queryKey = ["todos"]\nexport const f = (qc: ReturnType<typeof useQueryClient>) => qc.getQueryData(queryKey)\n`,
    )
    expect(result.text).toBe(
      `import { useQueryClient } from "@nifrajs/web-react/query"\nimport { queryKey as nifraQueryKey } from "@nifrajs/web/client"\nconst queryKey = ["todos"]\nexport const f = (qc: ReturnType<typeof useQueryClient>) => qc.getQueryData(nifraQueryKey(queryKey))\n`,
    )
    expect(result.count).toBe(1)
  })

  test("a .svelte or .vue file lists its untyped keys, and leaves a wrapped one", () => {
    const result = run(
      "query-keys",
      "routes/a.svelte",
      '<script lang="ts">\n  import { useQueryClient } from "@nifrajs/web-svelte/query"\n  const qc = useQueryClient()\n  qc.setQueryData(["a"], 1)\n  qc.getQueryData<number>(queryKey(["b"]))\n</script>\n',
    )
    expect(result.count).toBe(0)
    expect(result.manual).toEqual([
      {
        line: 4,
        reason:
          'setQueryData takes a typed key: wrap the key in queryKey(...), from "@nifrajs/web/client"',
      },
    ])
  })

  test("a file with TanStack's client, or no Nifra import, is not touched", () => {
    for (const text of [
      `import { useQueryClient } from "@tanstack/react-query"\nimport { x } from "@nifrajs/web"\nuseQueryClient().setQueryData(["a"], 1)\n`,
      `declare const qc: { setQueryData(k: unknown, v: unknown): void }\nqc.setQueryData(["a"], 1)\n`,
    ]) {
      expect(run("query-keys", "a.ts", text)).toEqual({ text, count: 0, manual: [] })
    }
  })
})

describe("form-for rewrite", () => {
  const head = 'import { formFor } from "@nifrajs/web/forms"\n'

  test("path and method type arguments become the call's arguments", () => {
    const result = run(
      "form-for",
      "routes/x.tsx",
      `${head}const a = formFor<typeof backend, "/todos">()\nconst b = formFor<typeof backend, "/todos", "delete">()\n`,
    )
    expect(result.text).toBe(
      `${head}const a = formFor<typeof backend>()("/todos")\nconst b = formFor<typeof backend>()("/todos", "delete")\n`,
    )
    expect(result.count).toBe(2)
  })

  test("a .svelte or .vue file lists the old form with its line", () => {
    const result = run(
      "form-for",
      "routes/a.vue",
      '<script setup lang="ts">\nimport { formFor } from "@nifrajs/web/forms"\nconst f = formFor<typeof backend, "/todos">()\n</script>\n',
    )
    expect(result.count).toBe(0)
    expect(result.manual).toHaveLength(1)
    expect(result.manual[0]?.line).toBe(3)
  })

  test("a path that is not a literal, and the new form, are not rewritten", () => {
    const text = `${head}const a = formFor<typeof backend, Path>()\nconst b = formFor<typeof backend>()("/todos")\n`
    const result = run("form-for", "routes/x.tsx", text)
    expect(result.text).toBe(text)
    expect(result.count).toBe(0)
    expect(result.manual).toHaveLength(1)
    expect(result.manual[0]?.line).toBe(2)
  })
})
