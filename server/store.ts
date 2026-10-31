import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CoordinatorMessage, PilotId } from "../shared/contract";
import type { RelaySendMessageInput } from "@agent-relay/sdk";

export class Store {
  readonly db: Database;
  constructor(filename = ".counterwhorl/coordinator.sqlite") {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new Database(filename, { create: true });
    chmodSync(filename, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS cursors (run_id TEXT NOT NULL, pilot TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(run_id,pilot));
      CREATE TABLE IF NOT EXISTS responses (message_id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outgoing (key TEXT PRIMARY KEY, body TEXT NOT NULL);`);
  }
  setting(key: string): string | undefined {
    return this.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM settings WHERE key=?",
      )
      .get(key)?.value;
  }
  setSetting(key: string, value: string): void {
    this.db
      .query("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)")
      .run(key, value);
  }
  registerRun(id: string): void {
    this.db.query("INSERT OR IGNORE INTO runs(id) VALUES (?)").run(id);
  }
  runs(): string[] {
    return this.db
      .query<{ id: string }, []>("SELECT id FROM runs")
      .all()
      .map((r) => r.id);
  }
  hasRun(id: string): boolean {
    return !!this.db.query("SELECT 1 FROM runs WHERE id=?").get(id);
  }
  cursor(runId: string, pilot: PilotId): number {
    return (
      this.db
        .query<{ revision: number }, [string, string]>(
          "SELECT revision FROM cursors WHERE run_id=? AND pilot=?",
        )
        .get(runId, pilot)?.revision ?? 0
    );
  }
  checkpoint(runId: string, pilot: PilotId, revision: number): void {
    this.db
      .query(
        "INSERT INTO cursors(run_id,pilot,revision) VALUES (?,?,?) ON CONFLICT(run_id,pilot) DO UPDATE SET revision=MAX(revision,excluded.revision)",
      )
      .run(runId, pilot, revision);
  }
  response(
    messageId: string,
    senderId: string,
  ): CoordinatorMessage | undefined {
    const row = this.db
      .query<{ body: string }, [string, string]>(
        "SELECT body FROM responses WHERE message_id=? AND sender_id=?",
      )
      .get(messageId, senderId);
    return row ? JSON.parse(row.body) : undefined;
  }
  saveResponse(
    messageId: string,
    senderId: string,
    body: CoordinatorMessage,
  ): void {
    this.db
      .query(
        "INSERT OR IGNORE INTO responses(message_id,sender_id,body) VALUES (?,?,?)",
      )
      .run(messageId, senderId, JSON.stringify(body));
  }
  outgoing(key: string, payload: RelaySendMessageInput): RelaySendMessageInput {
    this.db
      .query("INSERT OR IGNORE INTO outgoing(key,body) VALUES (?,?)")
      .run(key, JSON.stringify(payload));
    return JSON.parse(
      this.db
        .query<{ body: string }, [string]>(
          "SELECT body FROM outgoing WHERE key=?",
        )
        .get(key)!.body,
    );
  }
  close(): void {
    this.db.close();
  }
}
