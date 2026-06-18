import { Database } from "bun:sqlite"

// One connection, opened once at module scope — the standard pattern. `:memory:` keeps the demo
// self-contained; swap for a path like "todos.db" to persist to disk. On Node you'd use
// `better-sqlite3`; on the edge, Cloudflare D1 / Turso (libSQL) — the route code below doesn't change.
const db = new Database(":memory:")
db.run("PRAGMA journal_mode = WAL")
db.run(`
  CREATE TABLE IF NOT EXISTS todos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT    NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
    done       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  )
`)

export interface Todo {
  id: number
  text: string
  done: number
  created_at: string
}

// Prepared, PARAMETERIZED statements (the `?` placeholders) — never interpolate user input into SQL.
// The `<Todo>` generic types every row, so `todos.*` is fully typed with no cast.
const q = {
  all: db.query<Todo, []>("SELECT * FROM todos ORDER BY id DESC"),
  byId: db.query<Todo, [number]>("SELECT * FROM todos WHERE id = ?"),
  insert: db.query<Todo, [string]>("INSERT INTO todos (text) VALUES (?) RETURNING *"),
  toggle: db.query<Todo, [number]>("UPDATE todos SET done = 1 - done WHERE id = ? RETURNING *"),
  del: db.query<{ id: number }, [number]>("DELETE FROM todos WHERE id = ? RETURNING id"),
}

export const todos = {
  list: (): Todo[] => q.all.all(),
  get: (id: number): Todo | null => q.byId.get(id),
  create: (text: string): Todo => {
    const row = q.insert.get(text) // RETURNING * always yields the inserted row
    if (row === null) throw new Error("insert failed")
    return row
  },
  toggle: (id: number): Todo | null => q.toggle.get(id),
  remove: (id: number): boolean => q.del.get(id) !== null,
}
