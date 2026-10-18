// A minimal D1Database stand-in over node:sqlite for Worker tests. It runs the real migrations.
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

type Value = string | number | null;

class Statement {
  private values: Value[] = [];
  constructor(private readonly db: DatabaseSync, readonly sql: string) {}
  bind(...values: Value[]) {
    const next = new Statement(this.db, this.sql);
    next.values = values;
    return next;
  }
  private named() {
    // D1 uses ?1, ?2 … ; node:sqlite accepts them as positional parameters.
    return this.db.prepare(this.sql);
  }
  async first<T>() {
    return (this.named().get(...this.values) as T | undefined) ?? null;
  }
  allSync<T>() {
    return { results: this.named().all(...this.values) as T[], success: true, meta: {} };
  }
  runSync() {
    const info = this.named().run(...this.values);
    return { results: [], success: true, meta: { changes: Number(info.changes) } };
  }
  async all<T>() {
    return this.allSync<T>();
  }
  async run() {
    return this.runSync();
  }
}

export function createTestD1(): D1Database & { raw: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  const api = {
    raw: db,
    prepare: (sql: string) => new Statement(db, sql),
    // Runs without awaiting between statements, so concurrent batches can't interleave (as in D1).
    async batch(statements: Statement[]) {
      db.exec("BEGIN");
      try {
        const results = statements.map((statement) => (/^\s*select/i.test(statement.sql) ? statement.allSync() : statement.runSync()));
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  };
  return api as unknown as D1Database & { raw: DatabaseSync };
}
