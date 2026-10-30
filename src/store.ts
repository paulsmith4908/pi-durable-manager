import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, chmod } from "node:fs/promises";
import { chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sanitizeActivity, type ActivityEntry, type ActivityInput } from "./activity.js";
import { redactString, type KnownSecrets } from "./redact.js";

/**
 * Application metadata store.
 *
 * This is OUR store: project registry, session mapping, assignment request
 * records, and the idempotent creation journal. It is a SEPARATE node:sqlite
 * database from Pi's own durable storage, owned by the same service process.
 * The two are reconciled through this journal (by Pi IDs and request IDs), not
 * through one shared transaction.
 *
 * One writer: the service opens the database exclusively for its lifetime and
 * only through {@link MetadataStore.open}. Clients never touch this file.
 */

/** Current application schema version. Bump and add a migration to change it. */
export const SCHEMA_VERSION = 8;

/** Default journal entry statuses. */
export type JournalStatus = "preparing" | "ready" | "error";

/** A journal entry: one idempotent operation keyed by `(kind, requestId)`. */
export interface JournalRecord {
  readonly id: number;
  readonly kind: string;
  readonly requestId: string;
  readonly payloadHash: string;
  readonly status: JournalStatus;
  readonly resultId: string | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Stored project record. */
export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  /** Canonical absolute path of the project checkout. */
  readonly path: string;
  /** `created` for a fresh git init, `imported` for an existing directory. */
  readonly origin: "created" | "imported";
  readonly requestId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Stored session record mapping a Pi conversation to a project. */
export interface SessionRecord {
  readonly id: string;
  readonly projectId: string;
  /** Pi conversation id, stored as a string because Pi brands it as a number. */
  readonly conversationId: string;
  readonly requestId: string;
  readonly createdAt: number;
}

/**
 * Lifecycle state of an assignment, as persisted by our metadata store.
 *
 * This is OUR coarse state, distinct from Pi's per-submission status. It moves
 * `queued` -> `running` -> `needs_review` on the happy path, and to one of the
 * incomplete terminal states (`failed`/`unanswered`/`budget`/`timeout`/
 * `blocked`) otherwise. Only operator review may promote an assignment beyond
 * `needs_review`; the engine never records `accepted` by itself.
 */
export type AssignmentState =
  | "queued"
  | "running"
  | "needs_review"
  | "accepted"
  | "revision_requested"
  | "failed"
  | "unanswered"
  | "budget"
  | "timeout"
  | "cancelling"
  | "cancelled"
  | "blocked";

/** Terminal assignment states (no further progress without a new assignment). */
export const TERMINAL_ASSIGNMENT_STATES: readonly AssignmentState[] = [
  "needs_review",
  "accepted",
  "revision_requested",
  "failed",
  "unanswered",
  "budget",
  "timeout",
  "cancelled",
];

/** A stored assignment request and its durable execution state. */
export interface AssignmentRecord {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string | null;
  /** Pi conversation the assignment drives, stored as a string. */
  readonly conversationId: string | null;
  readonly requestId: string;
  readonly state: AssignmentState;
  /** JSON-encoded acceptance criteria supplied by the operator. */
  readonly acceptanceCriteria: string | null;
  /** Pi submission id once admitted; required for reattach after restart. */
  readonly submissionId: string | null;
  /** Stable payload hash used to detect requestId reuse with a new payload. */
  readonly payloadHash: string;
  /** Parent assignment id when this is a revision of an earlier assignment. */
  readonly parentId: string | null;
  /**
   * Redacted task text as submitted by the operator. Persisted so an operator
   * can review WHAT was asked even after a crash/restart, and surfaced via the
   * assignment detail. Bounded and redacted before storage.
   */
  readonly task: string | null;
  /** Model-generation attempts consumed so far (every attempt/restart counts). */
  readonly attemptCount: number;
  /** Absolute epoch-ms deadline for the whole assignment, or null when unbounded. */
  readonly deadlineAt: number | null;
  /**
   * The final assistant message's stop reason (e.g. `stop`, `length`, `error`,
   * `aborted`) once observed, used to classify an incomplete stop. Null until a
   * terminal provider message has been seen.
   */
  readonly stopReason: string | null;
  /** Writer-lease owner (canonical checkout) held while the assignment runs. */
  readonly leasePath: string | null;
  /** JSON-encoded evidence summary (changed files, command results). */
  readonly evidence: string | null;
  /** Operator review note recorded by `assignments.review`, if any. */
  readonly reviewNote: string | null;
  /** When the operator last reviewed this assignment, if ever. */
  readonly reviewedAt: number | null;
  /** Last redacted error message, if any. */
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Lifecycle of one tracked operator input (a steer/follow-up on a running
 * assignment).
 *
 * `preparing`  — intent persisted durably; the Pi submission has NOT yet been
 *                admitted (a crash here replays idempotently by requestId).
 * `admitted`   — admitted to Pi and the submission id is stored.
 * `done`       — the submission settled (terminal, either answered or not).
 * `error`      — admission failed; the input is terminal and never replayed.
 */
export type AssignmentInputState = "preparing" | "admitted" | "done" | "error";

/**
 * One tracked operator input on an assignment.
 *
 * The `(requestId)` primary key makes every operator input idempotent: a repeat
 * with the same content hash replays; a repeat with different content is a
 * conflict. The row is written BEFORE the input reaches Pi, so a restart can
 * reattach (or safely replay) every input instead of silently dropping it.
 */
export interface AssignmentInputRecord {
  /** Caller-supplied idempotency key; unique across ALL inputs. */
  readonly requestId: string;
  readonly assignmentId: string;
  /** `steer` interrupts the current turn; `followup` queues a new turn. */
  readonly mode: "steer" | "followup";
  /** Stable hash of the (already validated) content; detects id reuse. */
  readonly contentHash: string;
  /** Redacted, bounded content, kept so a restart can replay it verbatim. */
  readonly redactedContent: string;
  /** Pi submission id once admitted; null while `preparing`. */
  readonly submissionId: string | null;
  readonly state: AssignmentInputState;
  readonly createdAt: number;
}
export class StoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

/** Deterministic canonical JSON: object keys sorted, no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 hex digest of the canonical JSON form of `value`. */
export function payloadHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

const DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  result_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (kind, request_id)
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  conversation_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (conversation_id),
  UNIQUE (request_id)
);
CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT,
  conversation_id TEXT,
  request_id TEXT NOT NULL,
  state TEXT NOT NULL,
  acceptance_criteria TEXT,
  submission_id TEXT,
  payload_hash TEXT NOT NULL DEFAULT '',
  parent_id TEXT,
  lease_path TEXT,
  evidence TEXT,
  review_note TEXT,
  reviewed_at INTEGER,
  error TEXT,
  task TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  deadline_at INTEGER,
  stop_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (request_id)
);
CREATE TABLE IF NOT EXISTS assignment_inputs (
  request_id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  redacted_content TEXT NOT NULL,
  submission_id TEXT,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assignment_inputs_assignment
  ON assignment_inputs(assignment_id, created_at);
CREATE TABLE IF NOT EXISTS service_runs (
  boot_id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  clean INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  stopped_at INTEGER
);
CREATE TABLE IF NOT EXISTS process_receipts (
  receipt_id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  pid INTEGER,
  pgid INTEGER,
  command_redacted TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS process_receipts_assignment
  ON process_receipts(assignment_id, created_at);
CREATE INDEX IF NOT EXISTS process_receipts_boot
  ON process_receipts(boot_id, state);
CREATE TABLE IF NOT EXISTS manager_bindings (
  project_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  bound_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS manager_events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  conversation_id TEXT,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  thread_id TEXT,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,
  delivery_state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  receipt TEXT,
  acked INTEGER NOT NULL DEFAULT 0,
  acked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS manager_events_dedup
  ON manager_events(dedup_key);
CREATE INDEX IF NOT EXISTS manager_events_project
  ON manager_events(project_id, created_at);
CREATE INDEX IF NOT EXISTS manager_events_delivery
  ON manager_events(delivery_state, next_attempt_at);
CREATE TABLE IF NOT EXISTS manager_pause_intents (
  intent_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  conversation_id TEXT,
  task_id TEXT NOT NULL,
  question TEXT NOT NULL,
  context TEXT,
  detail TEXT NOT NULL,
  status TEXT NOT NULL,
  event_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS manager_pause_intents_assignment
  ON manager_pause_intents(assignment_id);
CREATE INDEX IF NOT EXISTS manager_pause_intents_status
  ON manager_pause_intents(status);
CREATE TABLE IF NOT EXISTS activity (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL, kind TEXT NOT NULL, project_id TEXT, assignment_id TEXT,
  request_id TEXT, dedup_key TEXT UNIQUE, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_assignment ON activity(assignment_id, seq);
CREATE INDEX IF NOT EXISTS activity_project ON activity(project_id, seq);
CREATE TABLE IF NOT EXISTS runtime_control (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
);
`;

/**
 * Open application metadata storage at `path`.
 *
 * Creates the parent directory with private (0700) permissions, the file
 * itself with 0600, and applies the schema (idempotently). Refuses a database
 * written by a newer schema version rather than guessing at its shape.
 */
export class MetadataStore {
  private readonly db: DatabaseSync;
  private readonly filePath: string;
  private closed = false;
  /** Nesting depth for {@link withTransaction}; 0 = no transaction open. */
  private txnDepth = 0;
  private activitySecrets: KnownSecrets | undefined;

  private constructor(db: DatabaseSync, filePath: string) {
    this.db = db;
    this.filePath = filePath;
  }

  static async open(filePath: string): Promise<MetadataStore> {
    const abs = resolve(filePath);
    await mkdir(dirname(abs), { recursive: true, mode: 0o700 });
    await chmod(dirname(abs), 0o700).catch(() => undefined);

    const db = new DatabaseSync(abs);
    try {
      chmodSync(abs, 0o600);
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec(DDL);

      const found = readSchemaVersion(db);
      if (found === undefined) {
        writeSchemaVersion(db, SCHEMA_VERSION);
      } else if (found > SCHEMA_VERSION) {
        throw new StoreError(
          "schema",
          `Metadata database schema version ${found} is newer than supported ${SCHEMA_VERSION}.`,
        );
      } else if (found < SCHEMA_VERSION) {
        migrate(db, found, SCHEMA_VERSION);
        writeSchemaVersion(db, SCHEMA_VERSION);
      }
      return new MetadataStore(db, abs);
    } catch (error) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  /** Absolute path of the opened database file. */
  get path(): string {
    return this.filePath;
  }

  get schemaVersion(): number {
    return readSchemaVersion(this.db) ?? SCHEMA_VERSION;
  }

  setActivitySecrets(secrets: KnownSecrets): void { this.activitySecrets = secrets; }

  appendActivity(input: ActivityInput): ActivityEntry {
    this.assertOpen();
    const safe = sanitizeActivity(input.data, this.activitySecrets);
    let data = JSON.stringify(safe);
    if (Buffer.byteLength(data) > 48000) data = JSON.stringify({ preview: data.slice(0, 10000), truncated: true });
    const result = this.db.prepare("INSERT OR IGNORE INTO activity(at,kind,project_id,assignment_id,request_id,dedup_key,data) VALUES(?,?,?,?,?,?,?)")
      .run(input.at ?? Date.now(), input.kind, input.projectId, input.assignmentId, input.requestId, input.dedupKey, data);
    const row = (input.dedupKey !== null
      ? this.db.prepare("SELECT * FROM activity WHERE dedup_key=?").get(input.dedupKey)
      : this.db.prepare("SELECT * FROM activity WHERE seq=?").get(result.lastInsertRowid)) as Record<string, unknown>;
    return this.activityRow(row);
  }

  listActivity(after = 0, limit = 50, projectId?: string): ActivityEntry[] {
    this.assertOpen();
    const rows = (projectId
      ? this.db.prepare("SELECT * FROM activity WHERE seq>? AND project_id=? ORDER BY seq LIMIT ?").all(after, projectId, Math.min(50, limit))
      : this.db.prepare("SELECT * FROM activity WHERE seq>? ORDER BY seq LIMIT ?").all(after, Math.min(50, limit))) as Record<string, unknown>[];
    const result: ActivityEntry[] = []; let bytes = 0;
    for (const row of rows) {
      const entry = this.activityRow(row); bytes += Buffer.byteLength(JSON.stringify(entry));
      if (bytes > 500000) break;
      result.push(entry);
    }
    return result;
  }

  latestWorkActivity(assignmentId: string): ActivityEntry | null {
    const row = this.db.prepare("SELECT * FROM activity WHERE assignment_id=? AND (kind LIKE 'worker.%' OR kind LIKE 'command.%' OR kind='assignment.state') ORDER BY seq DESC LIMIT 1")
      .get(assignmentId) as Record<string, unknown> | undefined;
    return row ? this.activityRow(row) : null;
  }

  private activityRow(row: Record<string, unknown>): ActivityEntry {
    return { seq: Number(row.seq), at: Number(row.at), kind: String(row.kind),
      projectId: row.project_id as string | null, assignmentId: row.assignment_id as string | null,
      requestId: row.request_id as string | null, dedupKey: row.dedup_key as string | null,
      data: JSON.parse(String(row.data)) };
  }

  getControl<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM runtime_control WHERE key=?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : null;
  }

  setControl(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO runtime_control(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .run(key, JSON.stringify(sanitizeActivity(value, this.activitySecrets)), Date.now());
  }

  /** Lossless workflow state, unlike the intentionally bounded display journal. */
  setWorkflowControl(key: string, value: unknown): void {
    if (!key.startsWith("workflow")) throw new StoreError("invalid_params", "Workflow key required.");
    const safe = (v: any): any => typeof v === "string" ? redactString(v, this.activitySecrets)
      : Array.isArray(v) ? v.map(safe) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k,x]) => [k,safe(x)])) : v;
    this.db.prepare("INSERT INTO runtime_control(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .run(key, JSON.stringify(safe(value)), Date.now());
  }

  /** Look up a journal entry by `(kind, requestId)`. */
  getJournal(kind: string, requestId: string): JournalRecord | undefined {
    this.assertOpen();
    const row = this.db
      .prepare(
        "SELECT id, kind, request_id, payload_hash, status, result_id, error, created_at, updated_at " +
          "FROM journal WHERE kind = ? AND request_id = ?",
      )
      .get(kind, requestId) as RawJournal | undefined;
    return row === undefined ? undefined : mapJournal(row);
  }

  /**
   * Begin a journal entry. Returns the existing entry when one is present.
   *
   * Idempotency contract: if an entry with the same `(kind, requestId)` exists
   * and its payload hash matches, the existing entry is returned untouched (the
   * caller may then replay the stored result). If the payload hash differs, the
   * request is a conflict and a {@link StoreError} with code `conflict` is
   * thrown. This never overwrites a prior result.
   */
  beginJournal(kind: string, requestId: string, payload: unknown): { record: JournalRecord; replayed: boolean } {
    this.assertOpen();
    const hash = payloadHash(payload);
    const existing = this.getJournal(kind, requestId);
    if (existing !== undefined) {
      if (existing.payloadHash !== hash) {
        throw new StoreError(
          "conflict",
          `Request ${kind}/${requestId} was already used with a different payload.`,
        );
      }
      return { record: existing, replayed: true };
    }
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO journal (kind, request_id, payload_hash, status, result_id, error, created_at, updated_at) " +
          "VALUES (?, ?, ?, 'preparing', NULL, NULL, ?, ?)",
      )
      .run(kind, requestId, hash, now, now);
    const record = this.getJournal(kind, requestId);
    if (record === undefined) throw new StoreError("journal", "Journal insert did not persist.");
    return { record, replayed: false };
  }

  /** Mark a journal entry `ready` with its result id. */
  completeJournal(kind: string, requestId: string, resultId: string): void {
    this.assertOpen();
    this.db
      .prepare("UPDATE journal SET status = 'ready', result_id = ?, error = NULL, updated_at = ? WHERE kind = ? AND request_id = ?")
      .run(resultId, Date.now(), kind, requestId);
  }

  /** Mark a journal entry `error` with a redacted message. */
  failJournal(kind: string, requestId: string, message: string): void {
    this.assertOpen();
    this.db
      .prepare("UPDATE journal SET status = 'error', error = ?, updated_at = ? WHERE kind = ? AND request_id = ?")
      .run(message, Date.now(), kind, requestId);
  }

  /** Journal entries left `preparing` by a crash, for reconciliation. */
  pendingJournal(): JournalRecord[] {
    this.assertOpen();
    const rows = this.db
      .prepare(
        "SELECT id, kind, request_id, payload_hash, status, result_id, error, created_at, updated_at " +
          "FROM journal WHERE status = 'preparing' ORDER BY id ASC",
      )
      .all() as RawJournal[];
    return rows.map(mapJournal);
  }

  insertProject(record: ProjectRecord): void {
    this.assertOpen();
    this.db
      .prepare(
        "INSERT INTO projects (id, name, path, origin, request_id, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(record.id, record.name, record.path, record.origin, record.requestId, record.createdAt, record.updatedAt);
  }

  getProject(id: string): ProjectRecord | undefined {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT id, name, path, origin, request_id, created_at, updated_at FROM projects WHERE id = ?")
      .get(id) as RawProject | undefined;
    return row === undefined ? undefined : mapProject(row);
  }

  getProjectByPath(path: string): ProjectRecord | undefined {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT id, name, path, origin, request_id, created_at, updated_at FROM projects WHERE path = ?")
      .get(path) as RawProject | undefined;
    return row === undefined ? undefined : mapProject(row);
  }

  listProjects(): ProjectRecord[] {
    this.assertOpen();
    const rows = this.db
      .prepare("SELECT id, name, path, origin, request_id, created_at, updated_at FROM projects ORDER BY created_at ASC")
      .all() as RawProject[];
    return rows.map(mapProject);
  }

  /** Close the database. Idempotent. */
  insertSession(record: SessionRecord): void {
    this.assertOpen();
    this.db
      .prepare(
        "INSERT INTO sessions (id, project_id, conversation_id, request_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(record.id, record.projectId, record.conversationId, record.requestId, record.createdAt);
  }

  getSession(id: string): SessionRecord | undefined {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT id, project_id, conversation_id, request_id, created_at FROM sessions WHERE id = ?")
      .get(id) as RawSession | undefined;
    return row === undefined ? undefined : mapSession(row);
  }

  getSessionByConversation(conversationId: string): SessionRecord | undefined {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT id, project_id, conversation_id, request_id, created_at FROM sessions WHERE conversation_id = ?")
      .get(conversationId) as RawSession | undefined;
    return row === undefined ? undefined : mapSession(row);
  }

  getSessionByRequest(requestId: string): SessionRecord | undefined {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT id, project_id, conversation_id, request_id, created_at FROM sessions WHERE request_id = ?")
      .get(requestId) as RawSession | undefined;
    return row === undefined ? undefined : mapSession(row);
  }

  listSessions(projectId?: string): SessionRecord[] {
    this.assertOpen();
    const rows = (
      projectId === undefined
        ? this.db
            .prepare(
              "SELECT id, project_id, conversation_id, request_id, created_at FROM sessions ORDER BY created_at ASC",
            )
            .all()
        : this.db
            .prepare(
              "SELECT id, project_id, conversation_id, request_id, created_at FROM sessions WHERE project_id = ? ORDER BY created_at ASC",
            )
            .all(projectId)
    ) as RawSession[];
    return rows.map(mapSession);
  }

  /**
   * Begin tracking an operator input, keyed by its requestId.
   *
   * Idempotency: a prior row with the SAME content hash is returned untouched
   * (the caller replays); a prior row with a DIFFERENT hash is a `conflict`
   * (requestId reuse with new content). The row is written in state
   * `preparing` BEFORE the input reaches Pi, so a crash here is replayable.
   */
  beginInput(record: {
    requestId: string;
    assignmentId: string;
    mode: "steer" | "followup";
    contentHash: string;
    redactedContent: string;
  }): AssignmentInputRecord {
    this.assertOpen();
    const existing = this.getInput(record.requestId);
    if (existing !== undefined) {
      if (existing.contentHash !== record.contentHash) {
        throw new StoreError(
          "conflict",
          `Input ${record.requestId} already exists with different content.`,
        );
      }
      return existing;
    }
    this.db
      .prepare(
        "INSERT INTO assignment_inputs (request_id, assignment_id, mode, content_hash, redacted_content, " +
          "submission_id, state, created_at) VALUES (?, ?, ?, ?, ?, NULL, 'preparing', ?)",
      )
      .run(
        record.requestId,
        record.assignmentId,
        record.mode,
        record.contentHash,
        record.redactedContent,
        Date.now(),
      );
    const created = this.getInput(record.requestId);
    if (created === undefined) throw new StoreError("internal", "Input vanished during insert.");
    return created;
  }

  /** Read one tracked input by requestId. */
  getInput(requestId: string): AssignmentInputRecord | undefined {
    this.assertOpen();
    const row = this.db
      .prepare(
        "SELECT request_id, assignment_id, mode, content_hash, redacted_content, submission_id, state, created_at " +
          "FROM assignment_inputs WHERE request_id = ?",
      )
      .get(requestId) as RawInput | undefined;
    return row === undefined ? undefined : mapInput(row);
  }

  /** List every tracked input for an assignment, oldest first. */
  listInputs(assignmentId: string): AssignmentInputRecord[] {
    this.assertOpen();
    const rows = this.db
      .prepare(
        "SELECT request_id, assignment_id, mode, content_hash, redacted_content, submission_id, state, created_at " +
          "FROM assignment_inputs WHERE assignment_id = ? ORDER BY created_at ASC, request_id ASC",
      )
      .all(assignmentId) as RawInput[];
    return rows.map(mapInput);
  }

  /** Move a tracked input to `admitted`, recording its Pi submission id. */
  markInputAdmitted(requestId: string, submissionId: string): void {
    this.assertOpen();
    this.db
      .prepare("UPDATE assignment_inputs SET submission_id = ?, state = 'admitted' WHERE request_id = ?")
      .run(submissionId, requestId);
  }

  /** Move a tracked input to a terminal `done`/`error` state. */
  setInputState(requestId: string, state: "done" | "error"): void {
    this.assertOpen();
    this.db.prepare("UPDATE assignment_inputs SET state = ? WHERE request_id = ?").run(state, requestId);
  }

  // --- durable process receipts + service boot records (schema v6) ----------

  /**
   * Record a service boot as DIRTY. Called synchronously on engine start
   * BEFORE any tool can run. Idempotent per bootId.
   */
  beginServiceRun(bootId: string, pid: number, at: number): void {
    this.assertOpen();
    this.db
      .prepare(
        "INSERT INTO service_runs (boot_id, pid, clean, started_at, stopped_at) VALUES (?, ?, 0, ?, NULL) " +
          "ON CONFLICT(boot_id) DO NOTHING",
      )
      .run(bootId, pid, at);
  }

  /** Mark a boot clean — ONLY after full drain + Pi storage close. */
  markServiceRunClean(bootId: string, at: number): void {
    this.assertOpen();
    this.db.prepare("UPDATE service_runs SET clean = 1, stopped_at = ? WHERE boot_id = ?").run(at, bootId);
  }

  /**
   * Persist a process receipt SYNCHRONOUSLY. Called BEFORE the START barrier is
   * released so no supervised command's side effects can precede durability.
   */
  insertProcessReceipt(record: ProcessReceipt): void {
    this.assertOpen();
    this.db
      .prepare(
        "INSERT INTO process_receipts (receipt_id, assignment_id, boot_id, pid, pgid, " +
          "command_redacted, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.receiptId,
        record.assignmentId,
        record.bootId,
        record.pid ?? null,
        record.pgid ?? null,
        record.commandRedacted,
        record.state,
        record.createdAt,
        record.updatedAt,
      );
  }

  /** Transition a receipt to a terminal state after its group is gone. */
  setProcessReceiptState(receiptId: string, state: ProcessReceiptState, at: number): void {
    this.assertOpen();
    this.db
      .prepare("UPDATE process_receipts SET state = ?, updated_at = ? WHERE receipt_id = ?")
      .run(state, at, receiptId);
  }

  listProcessReceipts(assignmentId: string): ProcessReceipt[] {
    this.assertOpen();
    const rows = this.db
      .prepare(
        "SELECT receipt_id, assignment_id, boot_id, pid, pgid, command_redacted, state, created_at, updated_at " +
          "FROM process_receipts WHERE assignment_id = ? ORDER BY created_at",
      )
      .all(assignmentId) as Record<string, unknown>[];
    return rows.map(mapProcessReceipt);
  }

  /** Every prior boot that did NOT shut down cleanly. */
  listUncleanServiceRuns(): ServiceRunRecord[] {
    this.assertOpen();
    const rows = this.db
      .prepare("SELECT boot_id, pid, clean, started_at, stopped_at FROM service_runs WHERE clean = 0")
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      bootId: String(r.boot_id),
      pid: Number(r.pid),
      clean: Number(r.clean) !== 0,
      startedAt: Number(r.started_at),
      stoppedAt: r.stopped_at === null ? null : Number(r.stopped_at),
    }));
  }

  /** Receipts belonging to any of the given boots that reached a run state. */
  listReceiptsForBoots(bootIds: readonly string[]): ProcessReceipt[] {
    this.assertOpen();
    if (bootIds.length === 0) return [];
    const placeholders = bootIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        "SELECT receipt_id, assignment_id, boot_id, pid, pgid, command_redacted, state, created_at, updated_at " +
          `FROM process_receipts WHERE boot_id IN (${placeholders}) ORDER BY created_at`,
      )
      .all(...bootIds) as Record<string, unknown>[];
    return rows.map(mapProcessReceipt);
  }

  /** Insert a new assignment record. */
  insertAssignment(record: AssignmentRecord): void {
    this.assertOpen();
    this.db
      .prepare(
        "INSERT INTO assignments (id, project_id, session_id, conversation_id, request_id, state, " +
          "acceptance_criteria, submission_id, payload_hash, parent_id, lease_path, evidence, review_note, reviewed_at, error, " +
          "task, attempt_count, deadline_at, stop_reason, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.projectId,
        record.sessionId,
        record.conversationId,
        record.requestId,
        record.state,
        record.acceptanceCriteria,
        record.submissionId,
        record.payloadHash,
        record.parentId,
        record.leasePath,
        record.evidence,
        record.reviewNote,
        record.reviewedAt,
        record.error,
        record.task,
        record.attemptCount,
        record.deadlineAt,
        record.stopReason,
        record.createdAt,
        record.updatedAt,
      );
  }

  getAssignment(id: string): AssignmentRecord | undefined {
    this.assertOpen();
    const row = this.db
      .prepare(`${ASSIGNMENT_COLUMNS} FROM assignments WHERE id = ?`)
      .get(id) as RawAssignment | undefined;
    return row === undefined ? undefined : mapAssignment(row);
  }

  getAssignmentByRequest(requestId: string): AssignmentRecord | undefined {
    this.assertOpen();
    const row = this.db
      .prepare(`${ASSIGNMENT_COLUMNS} FROM assignments WHERE request_id = ?`)
      .get(requestId) as RawAssignment | undefined;
    return row === undefined ? undefined : mapAssignment(row);
  }

  /** Assignments targeting a project, oldest first. */
  listAssignments(projectId?: string): AssignmentRecord[] {
    this.assertOpen();
    const rows = (
      projectId === undefined
        ? this.db.prepare(`${ASSIGNMENT_COLUMNS} FROM assignments ORDER BY created_at ASC`).all()
        : this.db
            .prepare(`${ASSIGNMENT_COLUMNS} FROM assignments WHERE project_id = ? ORDER BY created_at ASC`)
            .all(projectId)
    ) as RawAssignment[];
    return rows.map(mapAssignment);
  }

  /**
   * The assignment currently holding the writer lease for `leasePath`, if any.
   *
   * A lease is held whenever `lease_path` is non-null — REGARDLESS of state.
   * A `blocked` or terminal-but-not-yet-cleaned assignment still owns the
   * checkout (the lease is cleared only when cleanup completes), so it must be
   * detected here; otherwise a new submit could slip in and write concurrently.
   */
  getActiveLease(leasePath: string): AssignmentRecord | undefined {
    this.assertOpen();
    const row = this.db
      .prepare(
        `${ASSIGNMENT_COLUMNS} FROM assignments WHERE lease_path = ? ORDER BY created_at ASC LIMIT 1`,
      )
      .get(leasePath) as RawAssignment | undefined;
    return row === undefined ? undefined : mapAssignment(row);
  }

  /**
   * Apply a partial update to an assignment, bumping `updated_at`.
   * Unknown fields are ignored; `undefined` values are not written.
   */
  updateAssignment(
    id: string,
    patch: Partial<
      Pick<
        AssignmentRecord,
        | "state"
        | "submissionId"
        | "evidence"
        | "reviewNote"
        | "reviewedAt"
        | "error"
        | "leasePath"
        | "sessionId"
        | "conversationId"
        | "acceptanceCriteria"
        | "task"
        | "attemptCount"
        | "deadlineAt"
        | "stopReason"
      >
    >,
  ): void {
    this.assertOpen();
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    const map: Record<string, string> = {
      state: "state",
      submissionId: "submission_id",
      evidence: "evidence",
      reviewNote: "review_note",
      reviewedAt: "reviewed_at",
      error: "error",
      leasePath: "lease_path",
      sessionId: "session_id",
      conversationId: "conversation_id",
      acceptanceCriteria: "acceptance_criteria",
      task: "task",
      attemptCount: "attempt_count",
      deadlineAt: "deadline_at",
      stopReason: "stop_reason",
    };
    for (const [key, column] of Object.entries(map)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value !== undefined) {
        fields.push(`${column} = ?`);
        values.push(value as string | number | null);
      }
    }
    fields.push("updated_at = ?");
    values.push(String(Date.now()));
    this.db.prepare(`UPDATE assignments SET ${fields.join(", ")} WHERE id = ?`).run(...values, id);
  }

  /** Close the database. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /**
   * Run `fn` inside a single SQLite transaction (BEGIN IMMEDIATE/COMMIT, or
   * ROLLBACK on throw). This gives assignment-state + manager-outbox-event
   * ATOMICITY: the engine writes the state patch and the wake event in one
   * transaction, so a crash or an outbox write failure rolls back BOTH (or
   * commits BOTH) — an assignment can never end up in a reviewable state with
   * the matching wake event silently missing (or vice versa).
   *
   * Nested calls reuse the outermost transaction (a depth counter), so callers
   * can compose without spurious "cannot start a transaction within a
   * transaction" errors. Not re-entrant across await points: `fn` must run
   * synchronously (it does — better-sqlite3-style sync statements).
   */
  withTransaction<T>(fn: () => T): T {
    this.assertOpen();
    if (this.txnDepth > 0) {
      this.txnDepth += 1;
      try {
        return fn();
      } finally {
        this.txnDepth -= 1;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.txnDepth = 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore rollback failure; surface the original error */
      }
      throw error;
    } finally {
      this.txnDepth = 0;
    }
  }

  // ---- Manager bindings ---------------------------------------------------

  /** Insert or replace the SINGLE manager binding for a project. */
  upsertManagerBinding(record: ManagerBindingRecord): void {
    this.assertOpen();
    this.db
      .prepare(
        "INSERT INTO manager_bindings (project_id, thread_id, request_id, bound_at, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(project_id) DO UPDATE SET thread_id = excluded.thread_id, " +
          "request_id = excluded.request_id, bound_at = excluded.bound_at, updated_at = excluded.updated_at",
      )
      .run(
        record.projectId,
        record.threadId,
        record.requestId,
        record.boundAt ?? record.createdAt ?? 0,
        record.createdAt,
        record.updatedAt,
      );
  }

  getManagerBinding(projectId: string): ManagerBindingRecord | undefined {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT * FROM manager_bindings WHERE project_id = ?")
      .get(projectId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : mapManagerBinding(row);
  }

  listManagerBindings(): ManagerBindingRecord[] {
    this.assertOpen();
    const rows = this.db
      .prepare("SELECT * FROM manager_bindings ORDER BY created_at ASC")
      .all() as Record<string, unknown>[];
    return rows.map(mapManagerBinding);
  }

  /** Remove a project's binding; returns true when a row existed. Idempotent. */
  deleteManagerBinding(projectId: string): boolean {
    this.assertOpen();
    const info = this.db.prepare("DELETE FROM manager_bindings WHERE project_id = ?").run(projectId);
    return Number(info.changes) > 0;
  }

  /**
   * Persist a durable manager-request PAUSE INTENT. This is written BEFORE any
   * cleanup so that (a) the intent survives a crash/restart and can be finished
   * by startup reconciliation, and (b) a fresh tool call can never re-enter. It
   * is idempotent by `intent_id`.
   */
  insertManagerPauseIntent(record: ManagerPauseIntentRecord): void {
    this.assertOpen();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO manager_pause_intents " +
          "(intent_id, project_id, assignment_id, conversation_id, task_id, question, context, detail, status, event_id, error, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.intentId,
        record.projectId,
        record.assignmentId,
        record.conversationId,
        record.taskId,
        record.question,
        record.context,
        record.detail,
        record.status,
        record.eventId,
        record.error,
        record.createdAt,
        record.updatedAt,
      );
  }

  getManagerPauseIntent(intentId: string): ManagerPauseIntentRecord | undefined {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT * FROM manager_pause_intents WHERE intent_id = ?")
      .get(intentId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : mapManagerPauseIntent(row);
  }

  /** The most recent pause intent for an assignment, if any. */
  getManagerPauseIntentForAssignment(assignmentId: string): ManagerPauseIntentRecord | undefined {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT * FROM manager_pause_intents WHERE assignment_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(assignmentId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : mapManagerPauseIntent(row);
  }

  /** Pause intents not yet finished (status = 'pending'); reconciled on startup. */
  listPendingManagerPauseIntents(): ManagerPauseIntentRecord[] {
    this.assertOpen();
    const rows = this.db
      .prepare("SELECT * FROM manager_pause_intents WHERE status = 'pending' ORDER BY created_at ASC")
      .all() as Record<string, unknown>[];
    return rows.map(mapManagerPauseIntent);
  }

  /** Mark a pause intent completed, recording the ACTUAL persisted event id. */
  completeManagerPauseIntent(intentId: string, eventId: string, at: number): void {
    this.assertOpen();
    this.db
      .prepare(
        "UPDATE manager_pause_intents SET status = 'completed', event_id = ?, error = NULL, updated_at = ? " +
          "WHERE intent_id = ?",
      )
      .run(eventId, at, intentId);
  }

  /** Mark a pause intent failed (cleanup could not be confirmed); keep detail. */
  failManagerPauseIntent(intentId: string, error: string, at: number): void {
    this.assertOpen();
    this.db
      .prepare("UPDATE manager_pause_intents SET status = 'failed', error = ?, updated_at = ? WHERE intent_id = ?")
      .run(error, at, intentId);
  }

  /**
   * Mark every not-yet-delivered event for `projectId` created strictly before
   * `boundAt` as `superseded`, so a new/retargeted binding NEVER receives a
   * historical replay (and a rebind does not route events recorded for an old
   * thread to the new one). Delivered events are untouched. Returns the count.
   */
  supersedePendingManagerEvents(projectId: string, boundAt: number): number {
    this.assertOpen();
    const info = this.db
      .prepare(
        "UPDATE manager_events SET delivery_state = 'superseded', next_attempt_at = NULL, updated_at = ? " +
          "WHERE project_id = ? AND acked = 0 AND delivery_state IN ('pending','failed') AND created_at < ?",
      )
      .run(Date.now(), projectId, boundAt);
    return Number(info.changes);
  }

  // ---- Manager wake outbox ------------------------------------------------

  /**
   * Record one manager wake event. IDEMPOTENT: the unique `dedup_key` means a
   * repeat of the same transition (same assignment+state+kind, e.g. a restart
   * re-observing a terminal) is a no-op and returns the existing row with
   * `inserted:false`. Returns the row and whether it was newly inserted.
   */
  insertManagerEvent(record: ManagerEventRecord): { record: ManagerEventRecord; inserted: boolean } {
    this.assertOpen();
    const info = this.db
      .prepare(
        "INSERT INTO manager_events (event_id, project_id, assignment_id, conversation_id, kind, state, " +
          "dedup_key, thread_id, summary, payload, delivery_state, attempts, next_attempt_at, last_error, " +
          "receipt, acked, acked_at, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(dedup_key) DO NOTHING",
      )
      .run(
        record.eventId,
        record.projectId,
        record.assignmentId,
        record.conversationId,
        record.kind,
        record.state,
        record.dedupKey,
        record.threadId,
        record.summary,
        record.payload,
        record.deliveryState,
        record.attempts,
        record.nextAttemptAt,
        record.lastError,
        record.receipt,
        record.acked ? 1 : 0,
        record.ackedAt,
        record.createdAt,
        record.updatedAt,
      );
    const inserted = Number(info.changes) > 0;
    if (inserted) this.appendActivity({ kind: "wake.recorded", projectId: record.projectId, assignmentId: record.assignmentId,
      requestId: null, dedupKey: `wake-recorded:${record.eventId}`, data: { eventId: record.eventId, kind: record.kind, summary: record.summary } });
    const existing = this.getManagerEventByDedup(record.dedupKey);
    return { record: existing ?? record, inserted };
  }

  getManagerEvent(eventId: string): ManagerEventRecord | undefined {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT * FROM manager_events WHERE event_id = ?")
      .get(eventId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : mapManagerEvent(row);
  }

  getManagerEventByDedup(dedupKey: string): ManagerEventRecord | undefined {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT * FROM manager_events WHERE dedup_key = ?")
      .get(dedupKey) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : mapManagerEvent(row);
  }

  /** Events for one project, oldest first, optionally only unacknowledged. */
  listManagerEvents(projectId?: string, unackedOnly = false): ManagerEventRecord[] {
    this.assertOpen();
    const clauses: string[] = [];
    const values: (string | number)[] = [];
    if (projectId !== undefined) {
      clauses.push("project_id = ?");
      values.push(projectId);
    }
    if (unackedOnly) clauses.push("acked = 0");
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM manager_events${where} ORDER BY created_at ASC`)
      .all(...values) as Record<string, unknown>[];
    return rows.map(mapManagerEvent);
  }

  /**
   * Pending events whose backoff window has elapsed, for ONE project, oldest
   * first, bounded by `limit`. Project-scoped on purpose: a global LIMIT would
   * let one busy project starve the others. `parked` (retries exhausted) and
   * `superseded` events are NEVER due again, so a restart cannot redeliver a
   * parked event forever.
   */
  listDueManagerEvents(projectId: string, now: number, limit = 100): ManagerEventRecord[] {
    this.assertOpen();
    const rows = this.db
      .prepare(
        "SELECT * FROM manager_events WHERE project_id = ? AND acked = 0 " +
          "AND delivery_state = 'pending' " +
          "AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at ASC LIMIT ?",
      )
      .all(projectId, now, limit) as Record<string, unknown>[];
    return rows.map(mapManagerEvent);
  }

  /** Distinct project ids that currently have at least one due event. */
  listProjectsWithDueManagerEvents(now: number, limit = 1000): string[] {
    this.assertOpen();
    const rows = this.db
      .prepare(
        "SELECT DISTINCT project_id FROM manager_events WHERE acked = 0 " +
          "AND delivery_state = 'pending' " +
          "AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY project_id ASC LIMIT ?",
      )
      .all(now, limit) as Record<string, unknown>[];
    return rows.map((row) => String(row.project_id));
  }

  /**
   * True when a project has at least one event that is due right now (pending,
   * unacked, `next_attempt_at` null or already elapsed). Used to continue
   * draining a batch larger than the per-pass size without waiting for a new
   * transition: a follow-up pass is scheduled immediately (delay 0). This is a
   * bounded drain — each pass delivers up to the batch size — so it cannot spin.
   */
  hasDueManagerEvents(projectId: string, now: number): boolean {
    this.assertOpen();
    const row = this.db
      .prepare(
        "SELECT 1 AS one FROM manager_events WHERE project_id = ? AND acked = 0 " +
          "AND delivery_state = 'pending' " +
          "AND (next_attempt_at IS NULL OR next_attempt_at <= ?) LIMIT 1",
      )
      .get(projectId, now) as Record<string, unknown> | undefined;
    return row !== undefined;
  }

  /**
   * Earliest `next_attempt_at` still scheduled among `pending` events for a
   * project, or null when none. Used to reschedule a retry timer for exactly
   * the delay that remains, instead of spinning.
   */
  earliestPendingManagerNextAttempt(projectId: string): number | null {
    this.assertOpen();
    const row = this.db
      .prepare(
        "SELECT MIN(next_attempt_at) AS t FROM manager_events WHERE project_id = ? " +
          "AND acked = 0 AND delivery_state = 'pending' AND next_attempt_at IS NOT NULL",
      )
      .get(projectId) as Record<string, unknown> | undefined;
    const value = row?.t;
    return value === null || value === undefined ? null : Number(value);
  }

  updateManagerEventDelivery(
    eventId: string,
    patch: {
      deliveryState?: ManagerEventDelivery;
      attempts?: number;
      nextAttemptAt?: number | null;
      lastError?: string | null;
      receipt?: string | null;
      threadId?: string | null;
      acked?: boolean;
      ackedAt?: number | null;
    },
  ): void {
    this.assertOpen();
    const map: Record<string, string> = {
      deliveryState: "delivery_state",
      attempts: "attempts",
      nextAttemptAt: "next_attempt_at",
      lastError: "last_error",
      receipt: "receipt",
      threadId: "thread_id",
      acked: "acked",
      ackedAt: "acked_at",
    };
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, column] of Object.entries(map)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value !== undefined) {
        fields.push(`${column} = ?`);
        values.push(typeof value === "boolean" ? (value ? 1 : 0) : (value as string | number | null));
      }
    }
    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    values.push(Date.now());
    this.db.prepare(`UPDATE manager_events SET ${fields.join(", ")} WHERE event_id = ?`).run(...values, eventId);
    const event = this.getManagerEvent(eventId);
    if (event) this.appendActivity({ kind: "wake.delivery", projectId: event.projectId, assignmentId: event.assignmentId,
      requestId: null, dedupKey: null, data: { eventId, ...patch } });
  }

  /** Acknowledge an event idempotently (no-op if already acked). */
  ackManagerEvent(eventId: string, at: number): void {
    this.assertOpen();
    this.db
      .prepare("UPDATE manager_events SET acked = 1, acked_at = ?, updated_at = ? WHERE event_id = ? AND acked = 0")
      .run(at, at, eventId);
    const event = this.getManagerEvent(eventId);
    if (event) this.appendActivity({ kind: "wake.acked", projectId: event.projectId, assignmentId: event.assignmentId,
      requestId: null, dedupKey: `wake-acked:${eventId}`, data: { eventId, at } });
  }

  /** Count undelivered (pending, unacked) events, optionally per project. */
  countPendingManagerEvents(projectId?: string): number {
    this.assertOpen();
    const row = (
      projectId === undefined
        ? this.db
            .prepare("SELECT COUNT(*) AS n FROM manager_events WHERE acked = 0 AND delivery_state = 'pending'")
            .get()
        : this.db
            .prepare(
              "SELECT COUNT(*) AS n FROM manager_events WHERE project_id = ? AND acked = 0 AND delivery_state = 'pending'",
            )
            .get(projectId)
    ) as { n: number };
    return Number(row.n);
  }

  /** Count retries-exhausted (parked) events, optionally per project. */
  countParkedManagerEvents(projectId?: string): number {
    this.assertOpen();
    const row = (
      projectId === undefined
        ? this.db.prepare("SELECT COUNT(*) AS n FROM manager_events WHERE acked = 0 AND delivery_state = 'parked'").get()
        : this.db
            .prepare(
              "SELECT COUNT(*) AS n FROM manager_events WHERE project_id = ? AND acked = 0 AND delivery_state = 'parked'",
            )
            .get(projectId)
    ) as { n: number };
    return Number(row.n);
  }

  private assertOpen(): void {
    if (this.closed) throw new StoreError("closed", "Metadata store is closed.");
  }
}

function readSchemaVersion(db: DatabaseSync): number | undefined {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (row === undefined) return undefined;
  const parsed = Number(row.value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function writeSchemaVersion(db: DatabaseSync, version: number): void {
  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(version));
}

/**
 * Apply forward migrations from `from` to `to`.
 *
 * Each step is additive and idempotent: columns are added with `ADD COLUMN`
 * guarded by a `PRAGMA table_info` probe, so a partially-migrated database
 * (a crash between steps) converges on rerun. We never drop or rewrite data.
 */
function migrate(db: DatabaseSync, from: number, to: number): void {
  if (from < 1 || to > SCHEMA_VERSION) {
    throw new StoreError("schema", `Cannot migrate metadata schema from ${from} to ${to}.`);
  }
  if (from < 2) {
    // v2: assignments gain conversation/submission/payload/lease/evidence/error
    // columns. Fresh databases already have them from the DDL above; an older
    // database gains them here.
    const columns = new Set(
      (db.prepare("PRAGMA table_info(assignments)").all() as { name: string }[]).map((c) => c.name),
    );
    const additions: readonly [string, string][] = [
      ["conversation_id", "TEXT"],
      ["submission_id", "TEXT"],
      ["payload_hash", "TEXT NOT NULL DEFAULT ''"],
      ["parent_id", "TEXT"],
      ["lease_path", "TEXT"],
      ["error", "TEXT"],
    ];
    for (const [name, type] of additions) {
      if (!columns.has(name)) {
        db.exec(`ALTER TABLE assignments ADD COLUMN ${name} ${type}`);
      }
    }
  }
  if (from < 3) {
    // v3: assignments gain operator-review columns. Fresh databases already
    // have them from the DDL above; an older database gains them here.
    const columns = new Set(
      (db.prepare("PRAGMA table_info(assignments)").all() as { name: string }[]).map((c) => c.name),
    );
    const additions: readonly [string, string][] = [
      ["review_note", "TEXT"],
      ["reviewed_at", "INTEGER"],
    ];
    for (const [name, type] of additions) {
      if (!columns.has(name)) {
        db.exec(`ALTER TABLE assignments ADD COLUMN ${name} ${type}`);
      }
    }
  }
  if (from < 4) {
    // v4: assignments gain bounded-lifecycle columns — the persisted task text
    // (redacted), the model-generation attempt counter, the absolute deadline,
    // and the last observed assistant stop reason. Fresh databases already have
    // them from the DDL above; older rows gain the columns with safe defaults
    // (`attempt_count` defaults to 0, everything else NULL) and are preserved.
    const columns = new Set(
      (db.prepare("PRAGMA table_info(assignments)").all() as { name: string }[]).map((c) => c.name),
    );
    const additions: readonly [string, string][] = [
      ["task", "TEXT"],
      ["attempt_count", "INTEGER NOT NULL DEFAULT 0"],
      ["deadline_at", "INTEGER"],
      ["stop_reason", "TEXT"],
    ];
    for (const [name, type] of additions) {
      if (!columns.has(name)) {
        db.exec(`ALTER TABLE assignments ADD COLUMN ${name} ${type}`);
      }
    }
  }
  if (from < 5) {
    // v5: a new `assignment_inputs` table tracks operator steer/follow-up
    // inputs durably, so an input is persisted BEFORE it reaches Pi and can be
    // reattached (or idempotently replayed) after a restart. Fresh databases
    // already have it from the DDL above; older ones gain it here. No existing
    // table is touched, so all prior rows are preserved.
    db.exec(`
      CREATE TABLE IF NOT EXISTS assignment_inputs (
        request_id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        redacted_content TEXT NOT NULL,
        submission_id TEXT,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS assignment_inputs_assignment
        ON assignment_inputs(assignment_id, created_at);
    `);
  }
  if (from < 6) {
    // v6: durable process receipts + service boot records. A `service_runs` row
    // marks each engine boot DIRTY on start and only flips to clean once the
    // engine has FULLY drained its tool groups and closed Pi storage. A
    // `process_receipts` row is written SYNCHRONOUSLY before a supervised
    // command's START barrier is released, so a crash can never leave an
    // unrecorded external command. No existing table is touched.
    db.exec(`
      CREATE TABLE IF NOT EXISTS service_runs (
        boot_id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        clean INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        stopped_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS process_receipts (
        receipt_id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL,
        boot_id TEXT NOT NULL,
        pid INTEGER,
        pgid INTEGER,
        command_redacted TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS process_receipts_assignment
        ON process_receipts(assignment_id, created_at);
      CREATE INDEX IF NOT EXISTS process_receipts_boot
        ON process_receipts(boot_id, state);
    `);
  }
  if (from < 7) {
    // v7: the manager WAKE outbox and explicit project->manager-thread bindings,
    // kept in the SAME single-writer database. `manager_bindings` maps exactly
    // one project to exactly one manager (Codex GUI) thread; binding starts from
    // NOW (no historical replay). `manager_events` is the durable, deduplicated
    // outbox: one row per meaningful state transition, carrying the delivery
    // state/attempts/receipt so a restart can drain pending wakes. No existing
    // table is touched, so all prior rows are preserved.
    db.exec(`
      CREATE TABLE IF NOT EXISTS manager_bindings (
        project_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        bound_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS manager_events (
        event_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        conversation_id TEXT,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        dedup_key TEXT NOT NULL,
        thread_id TEXT,
        summary TEXT NOT NULL,
        payload TEXT NOT NULL,
        delivery_state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        last_error TEXT,
        receipt TEXT,
        acked INTEGER NOT NULL DEFAULT 0,
        acked_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS manager_events_dedup
        ON manager_events(dedup_key);
      CREATE INDEX IF NOT EXISTS manager_events_project
        ON manager_events(project_id, created_at);
      CREATE INDEX IF NOT EXISTS manager_events_delivery
        ON manager_events(delivery_state, next_attempt_at);
    `);
  }
}

/** Best-effort synchronous chmod; the process umask may already apply 0600. */
interface RawJournal {
  id: number;
  kind: string;
  request_id: string;
  payload_hash: string;
  status: string;
  result_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface RawProject {
  id: string;
  name: string;
  path: string;
  origin: string;
  request_id: string;
  created_at: number;
  updated_at: number;
}

interface RawSession {
  id: string;
  project_id: string;
  conversation_id: string;
  request_id: string;
  created_at: number;
}

interface RawInput {
  request_id: string;
  assignment_id: string;
  mode: string;
  content_hash: string;
  redacted_content: string;
  submission_id: string | null;
  state: string;
  created_at: number;
}

function mapInput(row: RawInput): AssignmentInputRecord {
  return {
    requestId: row.request_id,
    assignmentId: row.assignment_id,
    mode: row.mode as AssignmentInputRecord["mode"],
    contentHash: row.content_hash,
    redactedContent: row.redacted_content,
    submissionId: row.submission_id,
    state: row.state as AssignmentInputRecord["state"],
    createdAt: row.created_at,
  };
}

/** Terminal/active states for a durable process receipt. */
export type ProcessReceiptState = "started" | "stopped" | "in_doubt";

/** A durable record of a supervised command's process group. */
export interface ProcessReceipt {
  readonly receiptId: string;
  readonly assignmentId: string;
  readonly bootId: string;
  readonly pid: number | null;
  readonly pgid: number | null;
  /** Redacted command text — never the raw model-supplied command. */
  readonly commandRedacted: string;
  readonly state: ProcessReceiptState;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A service boot record; `clean` is true only after a fully drained stop. */
export interface ServiceRunRecord {
  readonly bootId: string;
  readonly pid: number;
  readonly clean: boolean;
  readonly startedAt: number;
  readonly stoppedAt: number | null;
}

/**
 * Explicit project -> manager (Codex GUI) thread binding. One row per project;
 * binding takes effect from NOW, so no historical assignment is replayed.
 */
export interface ManagerBindingRecord {
  readonly projectId: string;
  /** The existing Codex GUI session/thread UUID the manager is woken on. */
  readonly threadId: string;
  readonly requestId: string;
  /**
   * Watermark (ms) from which this binding is effective. Events created before
   * `boundAt` are NOT delivered to this thread (bind-from-NOW): a rebind
   * supersedes earlier unbound/pending events so a new thread never receives a
   * historical replay. A late-bound or re-bound project therefore only wakes on
   * transitions that occur after the binding took effect. Optional on input;
   * the store defaults a missing value to `createdAt` (or 0 when also absent).
   */
  readonly boundAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Delivery lifecycle of one manager wake event in the durable outbox.
 * `superseded` marks an event that will never be delivered to the CURRENT
 * binding (it predates a bind/rebind) but whose history is preserved.
 */
export type ManagerEventDelivery = "pending" | "delivered" | "failed" | "parked" | "superseded";

/** One durable, deduplicated manager WAKE event. */
export interface ManagerEventRecord {
  readonly eventId: string;
  readonly projectId: string;
  readonly assignmentId: string;
  readonly conversationId: string | null;
  /** Transition that produced the wake (see ManagerEventKind). */
  readonly kind: string;
  readonly state: string;
  /** Stable dedup key; a second identical transition never yields a new event. */
  readonly dedupKey: string;
  readonly threadId: string | null;
  /** Bounded, redacted one-line summary (never a raw worker instruction). */
  readonly summary: string;
  /** JSON payload carrying the event id + bounded evidence, no transcript. */
  readonly payload: string;
  readonly deliveryState: ManagerEventDelivery;
  readonly attempts: number;
  readonly nextAttemptAt: number | null;
  readonly lastError: string | null;
  /** Trusted queue receipt (message id) on success, or null. */
  readonly receipt: string | null;
  readonly acked: boolean;
  readonly ackedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Durable marker for a worker → manager PAUSE. Written the instant
 * `request_manager` is called (before any process cleanup) so the pause is
 * durable and survives a restart; the async finalizer later records the ONE
 * outbox event and marks this intent `completed` (or `failed` if cleanup could
 * not be confirmed, in which case the event carries a truthful cleanup warning).
 */
export interface ManagerPauseIntentRecord {
  /** Truthful intent id returned to the worker (never a fabricated event id). */
  readonly intentId: string;
  readonly projectId: string;
  readonly assignmentId: string;
  readonly conversationId: string | null;
  readonly taskId: string;
  readonly question: string;
  readonly context: string | null;
  readonly detail: string;
  /** 'pending' until the finalizer runs; then 'completed' or 'failed'. */
  readonly status: string;
  /** The ACTUAL persisted outbox event id, once finalized. */
  readonly eventId: string | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function mapManagerPauseIntent(row: Record<string, unknown>): ManagerPauseIntentRecord {
  return {
    intentId: String(row.intent_id),
    projectId: String(row.project_id),
    assignmentId: String(row.assignment_id),
    conversationId: row.conversation_id === null ? null : String(row.conversation_id),
    taskId: String(row.task_id),
    question: String(row.question),
    context: row.context === null ? null : String(row.context),
    detail: String(row.detail),
    status: String(row.status),
    eventId: row.event_id === null ? null : String(row.event_id),
    error: row.error === null ? null : String(row.error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapManagerBinding(row: Record<string, unknown>): ManagerBindingRecord {
  return {
    projectId: String(row.project_id),
    threadId: String(row.thread_id),
    requestId: String(row.request_id),
    boundAt: row.bound_at === null || row.bound_at === undefined ? 0 : Number(row.bound_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapManagerEvent(row: Record<string, unknown>): ManagerEventRecord {
  return {
    eventId: String(row.event_id),
    projectId: String(row.project_id),
    assignmentId: String(row.assignment_id),
    conversationId: row.conversation_id === null ? null : String(row.conversation_id),
    kind: String(row.kind),
    state: String(row.state),
    dedupKey: String(row.dedup_key),
    threadId: row.thread_id === null ? null : String(row.thread_id),
    summary: String(row.summary),
    payload: String(row.payload),
    deliveryState: row.delivery_state as ManagerEventDelivery,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at === null ? null : Number(row.next_attempt_at),
    lastError: row.last_error === null ? null : String(row.last_error),
    receipt: row.receipt === null ? null : String(row.receipt),
    acked: Number(row.acked) !== 0,
    ackedAt: row.acked_at === null ? null : Number(row.acked_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapProcessReceipt(row: Record<string, unknown>): ProcessReceipt {
  return {
    receiptId: String(row.receipt_id),
    assignmentId: String(row.assignment_id),
    bootId: String(row.boot_id),
    pid: row.pid === null ? null : Number(row.pid),
    pgid: row.pgid === null ? null : Number(row.pgid),
    commandRedacted: String(row.command_redacted),
    state: row.state as ProcessReceiptState,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapJournal(row: RawJournal): JournalRecord {
  return {
    id: row.id,
    kind: row.kind,
    requestId: row.request_id,
    payloadHash: row.payload_hash,
    status: row.status as JournalStatus,
    resultId: row.result_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProject(row: RawProject): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    origin: row.origin as ProjectRecord["origin"],
    requestId: row.request_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSession(row: RawSession): SessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

/** Shared `SELECT` projection for assignment rows, prefixed with `SELECT `. */
const ASSIGNMENT_COLUMNS =
  "SELECT id, project_id, session_id, conversation_id, request_id, state, acceptance_criteria, " +
  "submission_id, payload_hash, parent_id, lease_path, evidence, review_note, reviewed_at, error, " +
  "task, attempt_count, deadline_at, stop_reason, created_at, updated_at";

interface RawAssignment {
  id: string;
  project_id: string;
  session_id: string | null;
  conversation_id: string | null;
  request_id: string;
  state: string;
  acceptance_criteria: string | null;
  submission_id: string | null;
  payload_hash: string;
  parent_id: string | null;
  lease_path: string | null;
  evidence: string | null;
  review_note: string | null;
  reviewed_at: number | null;
  error: string | null;
  task: string | null;
  attempt_count: number;
  deadline_at: number | null;
  stop_reason: string | null;
  created_at: number;
  updated_at: number;
}

function mapAssignment(row: RawAssignment): AssignmentRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    requestId: row.request_id,
    state: row.state as AssignmentState,
    acceptanceCriteria: row.acceptance_criteria,
    submissionId: row.submission_id,
    payloadHash: row.payload_hash,
    parentId: row.parent_id,
    leasePath: row.lease_path,
    evidence: row.evidence,
    reviewNote: row.review_note,
    reviewedAt: row.reviewed_at,
    error: row.error,
    task: row.task,
    attemptCount: row.attempt_count,
    deadlineAt: row.deadline_at,
    stopReason: row.stop_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
