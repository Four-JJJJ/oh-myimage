import { Pool } from "pg";
import type { AppDatabase, AppPreparedStatement } from "../worker/types";

export function createPostgresDatabase(connectionString: string): PostgresD1Database {
  const pool = new Pool({
    connectionString,
    max: Number(process.env.POSTGRES_POOL_SIZE ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return new PostgresD1Database(pool);
}

export class PostgresD1Database implements AppDatabase {
  constructor(private readonly pool: Pool) {}

  prepare(query: string): AppPreparedStatement {
    return new PostgresPreparedStatement(this.pool, query);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PostgresPreparedStatement implements AppPreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly pool: Pool,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): AppPreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    const result = await this.pool.query<Record<string, unknown>>(translateSql(this.query), this.values);
    return normalizeRow(result.rows[0]) as T | null;
  }

  async all<T = unknown>(): Promise<{ results?: T[] }> {
    const result = await this.pool.query<Record<string, unknown>>(translateSql(this.query), this.values);
    return { results: result.rows.map((row) => normalizeRow(row) as T) };
  }

  async run(): Promise<unknown> {
    const result = await this.pool.query(translateSql(this.query), this.values);
    return { success: true, meta: { changes: result.rowCount ?? 0 } };
  }
}

// SQL text comes from a small, fixed set of templates, so the translated form is
// memoised instead of being re-scanned character by character on every query.
const TRANSLATED_SQL_CACHE_LIMIT = 1_000;
const translatedSqlCache = new Map<string, string>();

export function translateSql(query: string): string {
  const cached = translatedSqlCache.get(query);
  if (cached !== undefined) return cached;
  const translated = translateSqlUncached(query);
  if (translatedSqlCache.size >= TRANSLATED_SQL_CACHE_LIMIT) translatedSqlCache.clear();
  translatedSqlCache.set(query, translated);
  return translated;
}

function translateSqlUncached(query: string): string {
  const normalized = query.replace(
    /\bCURRENT_TIMESTAMP\b/g,
    "to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')",
  );

  let index = 0;
  let inSingleQuote = false;
  let output = "";

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const next = normalized[i + 1];

    if (char === "'" && next === "'") {
      output += "''";
      i += 1;
      continue;
    }

    if (char === "'") {
      inSingleQuote = !inSingleQuote;
      output += char;
      continue;
    }

    if (char === "?" && !inSingleQuote) {
      index += 1;
      output += `$${index}`;
      continue;
    }

    output += char;
  }

  return output;
}

function normalizeRow(row: unknown): unknown {
  if (!row || typeof row !== "object") return row ?? null;
  const record = row as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if ((key === "count" || key.endsWith("_count")) && typeof value === "string") {
      const numberValue = Number(value);
      if (Number.isFinite(numberValue)) record[key] = numberValue;
    }
  }
  return record;
}
