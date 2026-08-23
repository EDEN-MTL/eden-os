import { readFileSync } from "fs";
import { join } from "path";
import { Pool, QueryResultRow } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

export async function initDb(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.warn("[DB] DATABASE_URL not set — skipping schema init");
    return;
  }
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
  await pool.query(schema);
  console.log("[DB] Schema up to date");
}
