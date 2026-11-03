import concurrent.futures
from contextlib import closing
import copy
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from research_ops import codex_adapter as adapter
from research_ops.contracts import REPORT_SCHEMA, load, safe_path, sha, task_card, validate_report, verify_inputs
from research_ops.host import Host, config_load
from research_ops.store import Store, digest


class OpsTests(unittest.TestCase):
    def setUp(self):
        parent = Path(__file__).resolve().parents[2] / "state/test-tmp"
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="case-", dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = self.root / "queue.sqlite3"
        self.store = Store(self.db)
        self.addCleanup(self.store.close)
        self.payload = {"repo_id": "repo-a", "permission": "read-only", "inputs": []}

    def task(self, event="one", repo="repo-a"):
        return self.store.enqueue(event, {**self.payload, "repo_id": repo})[0]

    def test_duplicate_is_idempotent(self):
        first = self.task()
        self.assertEqual(self.store.enqueue("one", self.payload), (first, False))
        self.assertEqual(len(self.store.list()), 1)

    def test_duplicate_changed_content_rejected(self):
        self.task()
        with self.assertRaises(ValueError):
            self.store.enqueue("one", {**self.payload, "objective": "changed"})

    def test_concurrent_duplicate_events(self):
        def submit(_):
            db = Store(self.db)
            try:
                return db.enqueue("same", self.payload)
            finally:
                db.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(submit, range(16)))
        self.assertEqual(len({r[0] for r in results}), 1)
        self.assertEqual(sum(r[1] for r in results), 1)

    def test_transaction_rolls_back_task_and_event(self):
        with patch.object(self.store, "event", side_effect=RuntimeError("injected failure")):
            with self.assertRaises(RuntimeError):
                self.task()
        self.assertEqual(self.store.list(), [])

    def test_multiworker_limits_and_same_repo_lock(self):
        first, second = self.task(), self.task("two")
        third = self.task("three", "repo-b")
        a = self.store.claim("worker-a", 2)
        b = self.store.claim("worker-b", 2)
        self.assertEqual({a["task_id"], b["task_id"]}, {first, third})
        self.assertIsNone(self.store.claim("worker-c", 2))
        self.store.finish(a["attempt_id"], "ready-for-review", {})
        self.assertEqual(self.store.claim("worker-c", 2)["task_id"], second)

    def test_concurrent_claims_do_not_duplicate_attempt(self):
        self.task()
        def claim(i):
            db = Store(self.db)
            try:
                return db.claim(str(i), 4)
            finally:
                db.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            claims = list(pool.map(claim, range(8)))
        self.assertEqual(sum(c is not None for c in claims), 1)

    def test_pause_preserves_queue(self):
        task = self.task()
        self.store.paused(True)
        self.assertIsNone(self.store.claim("w"))
        self.assertEqual(self.store.get(task)["state"], "queued")
        self.store.paused(False)
        self.assertIsNotNone(self.store.claim("w"))

    def test_cancelled_event_cannot_resurrect(self):
        task = self.task()
        self.store.cancel(task)
        self.task()
        with self.assertRaises(ValueError):
            self.store.retry(task)
        self.assertIsNone(self.store.claim("w"))

    def test_cancel_during_running_prevents_completion(self):
        task = self.task()
        attempt = self.store.claim("w")
        self.store.cancel(task)
        self.store.finish(attempt["attempt_id"], "ready-for-review", {})
        self.assertEqual(self.store.get(task)["state"], "cancelled")

    def test_restart_and_recovery_keep_uncertain_lock(self):
        task = self.task()
        attempt = self.store.claim("w", lease_seconds=1)
        self.assertEqual(self.store.recover(time.time() + 2), 1)
        reopened = Store(self.db)
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.get(task)["state"], "waiting-human")
        self.assertEqual(reopened.db.execute("SELECT count(*) FROM locks").fetchone()[0], 1)
        self.assertFalse(reopened.finish(attempt["attempt_id"], "ready-for-review", {}))
        with self.assertRaises(ValueError):
            reopened.reconcile(task)
        reopened.reconcile(task, True)
        reopened.retry(task)
        new = reopened.claim("new")
        self.assertEqual(new["generation"], 2)
        self.assertFalse(reopened.finish(attempt["attempt_id"], "ready-for-review", {}))

    def test_cancel_survives_recovery(self):
        task = self.task()
        self.store.claim("w", lease_seconds=1)
        self.store.cancel(task)
        self.store.recover(time.time() + 2)
        self.store.reconcile(task, True)
        self.assertEqual(self.store.get(task)["state"], "cancelled")

    def test_retry_is_bounded_and_explicit(self):
        task = self.task()
        attempt = self.store.claim("w")
        self.store.finish(attempt["attempt_id"], "failed", error="model unavailable")
        self.assertIsNone(self.store.claim("w"))
        with self.assertRaises(ValueError):
            self.store.retry(task, maximum_attempts=1)
        self.store.retry(task)
        self.assertEqual(self.store.get(task)["state"], "queued")

    def test_sessions_are_task_bound_and_retained_on_retry(self):
        task = self.task()
        attempt = self.store.claim("w")
        session = str(uuid.uuid4())
        self.assertTrue(self.store.bind_session(attempt["attempt_id"], session))
        with self.assertRaises(ValueError):
            self.store.bind_session(attempt["attempt_id"], str(uuid.uuid4()))
        self.store.finish(attempt["attempt_id"], "failed")
        self.store.retry(task)
        self.assertEqual(self.store.claim("w")["session_id"], session)

    def test_ready_for_review_is_not_done(self):
        task = self.task()
        attempt = self.store.claim("w")
        self.store.finish(attempt["attempt_id"], "ready-for-review", {})
        self.assertEqual(self.store.get(task)["state"], "ready-for-review")
        self.store.review(task, True)
        self.assertEqual(self.store.get(task)["state"], "done")

    def test_database_backup_is_readable(self):
        task = self.task()
        backup = self.root / "backup.sqlite3"
        self.store.backup(backup)
        with closing(sqlite3.connect(backup)) as db:
            self.assertEqual(db.execute("SELECT id FROM tasks").fetchone()[0], task)
        with self.assertRaises(ValueError):
            self.store.backup(backup)

    def test_newer_database_schema_rejected_without_reset(self):
        with closing(sqlite3.connect(self.root / "future.sqlite3")) as db:
            db.execute("PRAGMA user_version=99")
        with self.assertRaises(ValueError):
            Store(self.root / "future.sqlite3")

    def test_task_inputs_and_authorization(self):
        (self.root / "note.md").write_text("synthetic", encoding="utf-8")
        card = {"schema_version": 1, "event_id": "e", "repo_id": "r", "kind": "codex_review", "objective": "check", "inputs": ["note.md"]}
        config = {"repositories": {"r": {"root": str(self.root), "allow_model_review": True}}, "policy_sha256": "p"}
        payload = task_card(card, config)
        verify_inputs(payload)
        (self.root / "note.md").write_text("modified", encoding="utf-8")
        with self.assertRaises(ValueError):
            verify_inputs(payload)
        with self.assertRaises(ValueError):
            task_card({**card, "command": "delete files"}, config)
        with self.assertRaises(ValueError):
            task_card({**card, "kind": "shell"}, config)

    def test_path_escape_and_duplicate_json_rejected(self):
        for relative in ("../outside", "C:/outside", "/outside", "a\\b", "a//b"):
            with self.subTest(relative=relative), self.assertRaises(ValueError):
                safe_path(self.root, relative)
        (self.root / "bad.json").write_text('{"id":1,"id":2}', encoding="utf-8")
        with self.assertRaises(ValueError):
            load(self.root / "bad.json")

    def valid_report(self):
        return {"schema_version": 1, "task_id": "t", "attempt_id": "a", "outcome": "pass", "summary": "fixture",
                "checked_inputs": ["note.md"], "findings": [], "limitations": ["fixture only"]}

    def test_report_schema_and_input_references(self):
        report = self.valid_report()
        inputs = [{"path": "note.md"}]
        validate_report(report, "t", "a", inputs)
        for changes in ({"attempt_id": "stale"}, {"checked_inputs": []}, {"outcome": "completed"}, {"checked_inputs": ["elsewhere.md"]}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_report({**report, **changes}, "t", "a", inputs)

    def test_read_only_command_and_explicit_resume(self):
        session = str(uuid.uuid4())
        command = adapter.command({"executable": "codex"}, self.root, "schema", "output", session)
        self.assertIn("read-only", command)
        self.assertIn("never", command)
        self.assertIn(session, command)
        self.assertNotIn("--last", command)
        self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", command)
        self.assertEqual(command[-3:], ["resume", session, "-"])

    def test_event_parser_success_and_failed_turn(self):
        for failed in (False, True):
            with self.subTest(failed=failed):
                folder = self.root / ("failed" if failed else "pass")
                session = str(uuid.uuid4())
                events = [{"type": "thread.started", "thread_id": session}, {"type": "turn.failed" if failed else "turn.completed"}]
                script = "import json,sys; sys.stdin.read(); " + "; ".join("print(" + repr(json.dumps(e)) + ")" for e in events)
                seen = []
                result = adapter.run_process([sys.executable, "-c", script], self.root, folder, "fixture", 10, on_session=seen.append)
                self.assertEqual(result["session_id"], session)
                self.assertEqual(result["turn_failed"], failed)
                self.assertEqual(seen, [session])

    def test_missing_report_not_success_even_zero_exit(self):
        claim = {"task_id": "t", "attempt_id": "a", "payload": {"inputs": []}}
        result = {"returncode": 0, "turn_completed": True, "turn_failed": False, "event_error": None, "stop_reason": None, "session_id": str(uuid.uuid4())}
        with self.assertRaises(ValueError):
            adapter.validated_result(result, self.root / "missing.json", claim)

    def test_malformed_events_rejected(self):
        result = adapter.run_process([sys.executable, "-c", "print('not json')"], self.root, self.root / "malformed", "", 10)
        self.assertTrue(result["event_error"])

    def test_timeout_stops_owned_process(self):
        result = adapter.run_process([sys.executable, "-c", "import time; time.sleep(10)"], self.root, self.root / "timeout", "", 0.2)
        self.assertEqual(result["stop_reason"], "timeout")
        self.assertNotEqual(result["returncode"], 0)

    def test_timeout_stops_descendant(self):
        marker = self.root / "child-should-not-write.txt"
        child = "import time,pathlib; time.sleep(2); pathlib.Path(" + repr(str(marker)) + ").write_text('unexpected')"
        script = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c'," + repr(child) + "]); time.sleep(10)"
        result = adapter.run_process([sys.executable, "-c", script], self.root, self.root / "tree", "", 0.4)
        self.assertEqual(result["stop_reason"], "timeout")
        time.sleep(2)
        self.assertFalse(marker.exists())

    def test_finished_process_excess_output_is_rejected(self):
        with patch.object(adapter, "MAX_LOG_BYTES", 1024):
            result = adapter.run_process([sys.executable, "-c", "print('x'*2048)"], self.root, self.root / "huge", "", 10)
        self.assertEqual(result["stop_reason"], "output_limit")

    def test_incomplete_jsonl_is_rejected(self):
        with self.assertRaises(ValueError):
            adapter.run_process([sys.executable, "-c", "print('{',end='')"], self.root, self.root / "incomplete", "", 10)

    def test_stale_inputs_fail_before_executor_call(self):
        config = {"schema_version": 1, "repositories": {"r": {"root": str(self.root), "allow_model_review": True}}, "max_workers": 1,
                  "max_attempts": 3, "timeout_seconds": 60, "policy_sha256": "p"}
        host = Host(config, self.root / "host")
        self.addCleanup(host.close)
        note = self.root / "note.md"
        note.write_text("old", encoding="utf-8")
        card = {"schema_version": 1, "event_id": "e", "repo_id": "r", "kind": "codex_review", "objective": "check", "inputs": ["note.md"]}
        payload = task_card(card, config)
        task = host.store.enqueue("e", payload)[0]
        note.write_text("new", encoding="utf-8")
        with patch.object(host, "gate", return_value={}), patch.object(adapter, "execute") as execute:
            self.assertEqual(host.run_once()["state"], "failed")
            execute.assert_not_called()
        self.assertEqual(host.store.get(task)["generation"], 1)

    def test_compatibility_change_preserves_queued_task(self):
        config = {"schema_version": 1, "repositories": {}, "max_workers": 1, "max_attempts": 3, "timeout_seconds": 60, "policy_sha256": "p"}
        host = Host(config, self.root / "host")
        self.addCleanup(host.close)
        task = host.store.enqueue("e", self.payload)[0]
        old = {"version": "old"}
        adapter.atomic_json(host.state / "compatibility-accepted.json", {"status": "passed", "capability": old, "policy_sha256": "p"})
        with patch.object(host, "doctor", return_value={"version": "new"}):
            with self.assertRaises(ValueError):
                host.run_once()
        self.assertEqual(host.store.get(task)["state"], "queued")

    def test_private_model_review_requires_explicit_policy(self):
        card = {"schema_version": 1, "event_id": "e", "repo_id": "private", "kind": "codex_review", "objective": "check", "inputs": ["note.md"]}
        config = {"repositories": {"private": {"root": str(self.root)}}, "policy_sha256": "p"}
        with self.assertRaisesRegex(ValueError, "data-transfer authorization"):
            task_card(card, config)

    def test_executor_schema_pins_report_identity_and_input_paths(self):
        (self.root / "note.md").write_text("synthetic", encoding="utf-8")
        claim = {"task_id": "t", "attempt_id": "a", "payload": {"root": str(self.root), "objective": "review",
                 "inputs": [{"path": "note.md", "sha256": sha(self.root / "note.md")}]}}
        args, prompt, output = adapter.execute({"executable": "codex"}, claim, self.root, None, None)
        schema = load(self.root / "report.schema.json")
        self.assertEqual(schema["properties"]["checked_inputs"]["items"]["enum"], ["note.md"])
        self.assertEqual(schema["properties"]["attempt_id"]["enum"], ["a"])
        self.assertEqual(schema["properties"]["task_id"]["enum"], ["t"])


if __name__ == "__main__":
    unittest.main()
