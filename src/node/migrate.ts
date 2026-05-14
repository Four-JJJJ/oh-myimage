import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required.");

const migrationsDir = resolve(process.env.POSTGRES_MIGRATIONS_DIR ?? join(process.cwd(), "migrations", "postgres"));
const pool = new Pool({ connectionString });

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);

  const applied = new Set(
    (await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations")).rows.map((row) => row.filename),
  );
  const files = (await readdir(migrationsDir)).filter((file) => !file.startsWith(".") && file.endsWith(".sql")).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), "utf8");
    await pool.query("BEGIN");
    try {
      let statementIndex = 0;
      for (const statement of splitSqlStatements(sql)) {
        statementIndex += 1;
        try {
          await pool.query(statement);
        } catch (error) {
          console.error(`migration ${file} statement ${statementIndex} failed: ${statement.split("\n")[0]?.slice(0, 120)}`);
          throw error;
        }
      }
      await pool.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await pool.query("COMMIT");
      console.log(`applied ${file}`);
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }

  console.log("postgres migrations complete");
} finally {
  await pool.end();
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inSingleQuote = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "'" && next === "'") {
      current += "''";
      index += 1;
      continue;
    }

    if (char === "'") {
      inSingleQuote = !inSingleQuote;
      current += char;
      continue;
    }

    if (char === ";" && !inSingleQuote) {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      continue;
    }

    current += char;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}
