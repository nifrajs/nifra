import { boolean, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core"

// The schema is the source of truth — `drizzle-kit generate` derives SQL migrations from it.
// TIMESTAMPTZ + NOT NULL by default (production-grade columns).
export const todos = pgTable("todos", {
  id: serial("id").primaryKey(),
  text: text("text").notNull(),
  done: boolean("done").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type Todo = typeof todos.$inferSelect
