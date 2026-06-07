import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeon, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

/**
 * Lazily-initialized Drizzle client with two backends:
 *
 *  - **Neon (production / Vercel):** used when DATABASE_URL is a real
 *    postgres:// connection string.
 *  - **PGlite (zero-setup local dev):** Postgres compiled to WASM, stored in a
 *    local `.pglite` folder. Used automatically when no DATABASE_URL is set, so
 *    you can run the app with no external database at all.
 *
 * Initialization is deferred so `next build` (which evaluates these modules
 * without a database) never crashes.
 */
let _db: NeonHttpDatabase<typeof schema> | null = null;

function isNeonUrl(url: string | undefined): url is string {
  return !!url && /^postgres(ql)?:\/\//.test(url);
}

function getDb(): NeonHttpDatabase<typeof schema> {
  if (_db) return _db;

  const url = process.env.DATABASE_URL;
  if (isNeonUrl(url)) {
    _db = drizzleNeon(neon(url), { schema });
    return _db;
  }

  // Local fallback: Postgres-in-WASM. Required deps loaded only on this path.

  const { PGlite } = require("@electric-sql/pglite");

  const { drizzle: drizzlePglite } = require("drizzle-orm/pglite");
  const dir = process.env.PGLITE_DIR || ".pglite";
  _db = drizzlePglite(new PGlite(dir), { schema }) as unknown as NeonHttpDatabase<typeof schema>;
  return _db;
}

// Proxy so existing `db.select(...)` call sites keep working unchanged.
export const db = new Proxy({} as NeonHttpDatabase<typeof schema>, {
  get(_target, prop) {
    const instance = getDb();
    const value = instance[prop as keyof typeof instance];
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export * from "./schema";
