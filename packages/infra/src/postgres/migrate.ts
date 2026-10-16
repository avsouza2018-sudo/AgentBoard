import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface Migration {
  file: string;
  sql: string;
}

/**
 * Numbered SQL files, applied in filename order, each inside its own transaction and recorded
 * in `schema_migrations`. Re-running is a no-op, which is what makes the same runner usable from
 * a test, a CLI, and a deploy step without a third-party migration framework.
 */
export function migrationFiles(dir: string = DEFAULT_DIR): Migration[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: fs.readFileSync(path.join(dir, file), 'utf8') }));
}

export async function migrate(pool: Pool, dir: string = DEFAULT_DIR): Promise<string[]> {
  const applied: string[] = [];

  // The runner owns its own bookkeeping, so it cannot depend on a table created by a migration.
  await pool.query(`create table if not exists schema_migrations (
    file text primary key,
    applied_at timestamptz not null default now()
  )`);

  for (const migration of migrationFiles(dir)) {
    const existing = await pool.query('select 1 from schema_migrations where file = $1', [migration.file]);
    if ((existing.rowCount ?? 0) > 0) continue;

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(migration.sql);
      await client.query('insert into schema_migrations (file) values ($1)', [migration.file]);
      await client.query('commit');
      applied.push(migration.file);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  return applied;
}
