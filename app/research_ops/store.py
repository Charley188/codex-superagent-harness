"""SQLite task/attempt state. No model, shell or network operations in transactions."""
from contextlib import contextmanager, closing
import hashlib
import json
from pathlib import Path
import sqlite3
import time
import uuid


def canonical(data):
    return json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(data):
    return hashlib.sha256(canonical(data).encode("utf-8")).hexdigest()


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA journal_mode=WAL")
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, 1):
            self.db.close()
            raise ValueError(f"Unsupported database version {version}; restore/use compatible host, never recreate state")
        if version == 0:
            self.db.executescript('''
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS tasks (
              id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
              payload_hash TEXT NOT NULL, repo_id TEXT NOT NULL, state TEXT NOT NULL,
              generation INTEGER NOT NULL DEFAULT 0, session_id TEXT,
              created REAL NOT NULL, updated REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS attempts (
              id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
              generation INTEGER NOT NULL, worker_id TEXT NOT NULL, state TEXT NOT NULL,
              started REAL NOT NULL, lease_until REAL NOT NULL, session_id TEXT,
              report TEXT, error TEXT, UNIQUE(task_id,generation));
            CREATE TABLE IF NOT EXISTS locks (
              repo_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id));
            CREATE TABLE IF NOT EXISTS events (
              seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, kind TEXT NOT NULL,
              detail TEXT NOT NULL, created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT OR IGNORE INTO settings VALUES ('paused','false');
            PRAGMA user_version=1;
            COMMIT;
            ''')

    def close(self):
        self.db.close()

    @contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def event(self, task, kind, detail):
        self.db.execute("INSERT INTO events(task_id,kind,detail,created) VALUES(?,?,?,?)",
                        (task, kind, canonical(detail), time.time()))

    def enqueue(self, event_id, payload):
        encoded, signature = canonical(payload), digest(payload)
        with self.transaction():
            previous = self.db.execute("SELECT * FROM tasks WHERE event_id=?", (event_id,)).fetchone()
            if previous:
                if previous["payload_hash"] != signature:
                    raise ValueError("Same event ID has different content; submit a new explicit event")
                return previous["id"], False
            task = str(uuid.uuid4())
            now = time.time()
            self.db.execute("INSERT INTO tasks VALUES(?,?,?,?,?,?,0,NULL,?,?)",
                            (task, event_id, encoded, signature, payload["repo_id"], "queued", now, now))
            self.event(task, "submitted", {"event_id": event_id, "payload_hash": signature})
            return task, True

    def claim(self, worker_id, maximum=1, lease_seconds=60, expected_generations=None, roles=None):
        with self.transaction():
            if self.db.execute("SELECT value FROM settings WHERE key='paused'").fetchone()[0] == "true":
                return None
            # Uncertain/orphaned attempts keep their lock and count against capacity.
            if self.db.execute("SELECT count(*) FROM locks").fetchone()[0] >= maximum:
                return None
            candidates = self.db.execute('''SELECT * FROM tasks WHERE state='queued'
                AND repo_id NOT IN (SELECT repo_id FROM locks) ORDER BY created,rowid''').fetchall()
            task = next((r for r in candidates
                         if (expected_generations is None or expected_generations.get(r["id"]) == r["generation"])
                         and (roles is None or json.loads(r["payload"]).get("role", "general") in roles)), None)
            if task is None:
                return None
            attempt, generation, now = str(uuid.uuid4()), task["generation"] + 1, time.time()
            self.db.execute("INSERT INTO attempts VALUES(?,?,?,?,?,?,?,NULL,NULL,NULL)",
                            (attempt, task["id"], generation, worker_id, "running", now, now + lease_seconds))
            self.db.execute("INSERT INTO locks VALUES(?,?)", (task["repo_id"], attempt))
            self.db.execute("UPDATE tasks SET state='running',generation=?,updated=? WHERE id=?", (generation, now, task["id"]))
            self.event(task["id"], "claimed", {"attempt_id": attempt, "worker_id": worker_id, "generation": generation,
                                                "role": json.loads(task["payload"]).get("role", "general")})
            return {"attempt_id": attempt, "task_id": task["id"], "generation": generation,
                    "session_id": task["session_id"], "payload": json.loads(task["payload"])}

    def heartbeat(self, attempt, lease_seconds=60):
        return self.db.execute("UPDATE attempts SET lease_until=? WHERE id=? AND state='running'",
                               (time.time() + lease_seconds, attempt)).rowcount == 1

    def bind_session(self, attempt, session):
        uuid.UUID(session)
        with self.transaction():
            row = self.db.execute("SELECT * FROM attempts WHERE id=?", (attempt,)).fetchone()
            if row is None or row["state"] != "running":
                return False
            if row["session_id"] and row["session_id"] != session:
                raise ValueError("Conflicting session ID within an attempt")
            task = self.db.execute("SELECT * FROM tasks WHERE id=?", (row["task_id"],)).fetchone()
            if task["generation"] != row["generation"] or task["state"] not in ("running", "cancel_requested"):
                return False
            if task["session_id"] and task["session_id"] != session:
                raise ValueError("Resume returned a different task session")
            self.db.execute("UPDATE attempts SET session_id=? WHERE id=?", (session, attempt))
            self.db.execute("UPDATE tasks SET session_id=? WHERE id=?", (session, row["task_id"]))
            return True

    def cancellation_requested(self, task):
        return self.get(task)["state"] == "cancel_requested"

    def finish(self, attempt, state, report=None, error=None):
        if state not in ("ready-for-review", "failed", "cancelled", "interrupted"):
            raise ValueError("Invalid terminal attempt state")
        with self.transaction():
            row = self.db.execute("SELECT * FROM attempts WHERE id=?", (attempt,)).fetchone()
            if row is None or row["state"] != "running":
                return False
            task = self.db.execute("SELECT * FROM tasks WHERE id=?", (row["task_id"],)).fetchone()
            if task["generation"] != row["generation"] or task["state"] not in ("running", "cancel_requested"):
                return False
            if task["state"] == "cancel_requested":
                state = "cancelled"
            self.db.execute("UPDATE attempts SET state=?,report=?,error=? WHERE id=?",
                            (state, canonical(report) if report is not None else None, error, attempt))
            self.db.execute("UPDATE tasks SET state=?,updated=? WHERE id=?", (state, time.time(), row["task_id"]))
            self.db.execute("DELETE FROM locks WHERE attempt_id=?", (attempt,))
            self.event(row["task_id"], state, {"attempt_id": attempt, "error": error})
            return True

    def cancel(self, task):
        with self.transaction():
            row = self.get(task)
            if row["state"] in ("cancelled", "done"):
                return row["state"]
            state = "cancel_requested" if row["state"] in ("running", "waiting-human", "cancel_requested") else "cancelled"
            self.db.execute("UPDATE tasks SET state=?,updated=? WHERE id=?", (state, time.time(), task))
            self.event(task, "cancel", {"state": state})
            return state

    def paused(self, value):
        with self.transaction():
            self.db.execute("UPDATE settings SET value=? WHERE key='paused'", (canonical(value),))
            self.event(None, "pause" if value else "unpause", {})

    def recover(self, now=None):
        """Expired leases do NOT prove child exit. Preserve lock until operator reconciliation."""
        with self.transaction():
            rows = self.db.execute("SELECT * FROM attempts WHERE state='running' AND lease_until<?", (now or time.time(),)).fetchall()
            for row in rows:
                self.db.execute("UPDATE attempts SET state='interrupted' WHERE id=?", (row["id"],))
                self.db.execute("UPDATE tasks SET state=CASE WHEN state='cancel_requested' THEN state ELSE 'waiting-human' END,updated=? WHERE id=? AND generation=?",
                                (time.time(), row["task_id"], row["generation"]))
                self.event(row["task_id"], "recovery_required", {"attempt_id": row["id"], "lock_retained": True})
            return len(rows)

    def reconcile(self, task, confirmed_stopped=False):
        if not confirmed_stopped:
            raise ValueError("Check old process tree has stopped before releasing its lock")
        with self.transaction():
            row = self.get(task)
            if row["state"] not in ("waiting-human", "cancel_requested"):
                raise ValueError("Task is not awaiting recovery")
            attempt = self.db.execute("SELECT * FROM attempts WHERE task_id=? AND generation=?", (task, row["generation"])).fetchone()
            if attempt["state"] == "running":
                raise ValueError("Attempt still has a live lease; wait for host or recover after expiry")
            self.db.execute("DELETE FROM locks WHERE attempt_id=?", (attempt["id"],))
            target = "cancelled" if row["state"] == "cancel_requested" else "interrupted"
            self.db.execute("UPDATE tasks SET state=?,updated=? WHERE id=?", (target, time.time(), task))
            self.event(task, "reconciled", {"operator_confirmed_stopped": True})

    def retry(self, task, maximum_attempts=3):
        with self.transaction():
            row = self.get(task)
            if row["state"] not in ("failed", "interrupted"):
                raise ValueError("Only failed/interrupted tasks can be explicitly retried; cancelled tasks stay stopped")
            if row["generation"] >= maximum_attempts:
                raise ValueError("Attempt budget exhausted")
            self.db.execute("UPDATE tasks SET state='queued',updated=? WHERE id=?", (time.time(), task))
            self.event(task, "retry_requested", {})

    def review(self, task, accepted):
        with self.transaction():
            if self.get(task)["state"] != "ready-for-review":
                raise ValueError("Task is not ready for review")
            self.db.execute("UPDATE tasks SET state=?,updated=? WHERE id=?", ("done" if accepted else "failed", time.time(), task))
            self.event(task, "human_review", {"accepted": accepted})

    def get(self, task):
        row = self.db.execute("SELECT * FROM tasks WHERE id=?", (task,)).fetchone()
        if row is None:
            raise ValueError("Unknown task")
        return dict(row)

    def list(self):
        result = []
        for row in self.db.execute("SELECT id,event_id,repo_id,state,generation,session_id,updated,payload FROM tasks ORDER BY created,rowid"):
            item = dict(row)
            item["role"] = json.loads(item.pop("payload")).get("role", "general")
            result.append(item)
        return result

    def backup(self, path):
        path = Path(path)
        if path.exists():
            raise ValueError("Backup destination already exists")
        with closing(sqlite3.connect(path)) as target:
            self.db.backup(target)
