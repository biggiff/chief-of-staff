import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

const url = process.env.DATABASE_URL;
const isNeon = !!url && /^postgres(ql)?:\/\//.test(url);

export default defineConfig(
  isNeon
    ? {
        schema: "./src/db/schema.ts",
        out: "./drizzle",
        dialect: "postgresql",
        dbCredentials: { url: url! },
      }
    : {
        // Zero-setup local dev: push the schema straight into PGlite.
        schema: "./src/db/schema.ts",
        out: "./drizzle",
        dialect: "postgresql",
        driver: "pglite",
        dbCredentials: { url: process.env.PGLITE_DIR || ".pglite" },
      }
);
