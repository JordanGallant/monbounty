// Async Postgres backing for bounty402, shaped to mimic the bun:sqlite surface
// the app was written against so the migration is `await` + dialect, not a
// rewrite of every query. One process-wide pool; Supabase over the direct
// (IPv6) endpoint.
//
// Dialect rewrites applied centrally so call sites keep their SQLite SQL:
//   ?                -> $1..$n     (positional placeholders)
//   datetime('now')  -> now()::text (columns stay textual, as the app expects)
//   INSERT OR IGNORE -> INSERT ... ON CONFLICT DO NOTHING
import { SQL } from "bun";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for the Postgres backend");

export const sql = new SQL(url, { max: 8, idleTimeout: 20 });

/** SQLite dialect -> Postgres. Applied to every statement the shim runs. */
function translate(q: string): string {
  let out = q.replace(/datetime\(\s*'now'\s*\)/gi, "now()::text");
  out = out.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, "INSERT INTO");
  // `?` -> `$n`, skipping any inside single-quoted string literals.
  let i = 0, res = "", inStr = false;
  for (let c = 0; c < out.length; c++) {
    const ch = out[c];
    if (ch === "'") inStr = !inStr;
    if (ch === "?" && !inStr) { res += `$${++i}`; continue; }
    res += ch;
  }
  return res;
}

/** True when the source used INSERT OR IGNORE — we append the conflict clause. */
function ignored(orig: string): boolean {
  return /INSERT\s+OR\s+IGNORE/i.test(orig);
}

export const db = {
  /** Multi-statement DDL. Simple protocol; no params. */
  async exec(q: string): Promise<void> {
    await sql.unsafe(translate(q)).simple();
  },

  /** Fire-and-forget write. Accepts the bun:sqlite `run(sql, [params])` shape. */
  async run(q: string, params: unknown[] = []): Promise<void> {
    let pg = translate(q);
    if (ignored(q)) pg += " ON CONFLICT DO NOTHING";
    await sql.unsafe(pg, params as any[]);
  },

  /** `db.query<Row>(sql).get(...p) / .all(...p)`, now async. */
  query<Row = any, _P = unknown[]>(q: string) {
    const pg = translate(q);
    return {
      async get(...params: unknown[]): Promise<Row | undefined> {
        const rows = (await sql.unsafe(pg, params as any[])) as Row[];
        return rows[0];
      },
      async all(...params: unknown[]): Promise<Row[]> {
        return (await sql.unsafe(pg, params as any[])) as Row[];
      },
    };
  },

  /** `db.prepare(sql).run(...p)`, now async. */
  prepare(q: string) {
    let pg = translate(q);
    if (ignored(q)) pg += " ON CONFLICT DO NOTHING";
    return {
      async run(...params: unknown[]): Promise<void> {
        await sql.unsafe(pg, params as any[]);
      },
    };
  },
};
