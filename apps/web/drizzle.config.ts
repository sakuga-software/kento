import { defineConfig } from 'drizzle-kit'

// `drizzle-kit generate` compares app/db/schema.ts with the snapshots in drizzle/meta and writes
// the next SQL migration. It needs no database.
export default defineConfig({
  dialect: 'postgresql',
  schema: './app/db/schema.ts',
  out: './drizzle',
})
