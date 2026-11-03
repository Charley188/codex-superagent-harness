"""Boundary tests for the new bridge; no model calls or host config edits."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("durable_worker", HERE / "durable_worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        area = HERE.parents[1] / "state/test-tmp/durable-python"
        area.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=area)
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.folder = self.base / "state/dsh-core" / str(uuid.uuid4())
        self.folder.mkdir(parents=True)
        fixture = self.base / "fixture"
        fixture.mkdir()
        (fixture / "parallel-a.md").write_text("SYNTHETIC_A only", encoding="utf-8")
        self.config = {"repositories": {"synthetic-fixture": {"root": str(fixture), "allow_model_review": True}},
                       "policy_sha256": "policy", "timeout_seconds": 120}
        self.capability = {"executable": "unused-codex"}
        self.request = {"version": 1, "ticket_id": "ticket", "assignment_id": "assignment", "turn_id": self.folder.name,
                        "session_id": None, "origin": [], "inputs": [], "contract": {
                            "repo_id": "synthetic-fixture", "worker_role": "arbitrary responsibility", "objective": "Review synthetic input",
                            "permission": "read-only", "inputs": [{"path": "parallel-a.md", "sha256": worker.adapter.sha(fixture / "parallel-a.md")}]}}
        self.path = self.folder / "request.json"
        (self.folder / "heartbeat").write_text("alive")
        p = patch.object(worker, "BASE", self.base); p.start(); self.addCleanup(p.stop)

    def fake_process(self, args, cwd, folder, prompt, timeout, **kwargs):
        self.assertIn("read-only", args)
        self.assertTrue(kwargs["heartbeat"]())
        self.assertFalse(kwargs["cancel"]())
        self.assertIn("Untrusted task messages", prompt)
        session = self.request["session_id"] or str(uuid.uuid4())
        if self.request["session_id"]:
            self.assertEqual(args[-3:], ["resume", session, "-"])
        report = {"schema_version": 1, "task_id": "ticket", "attempt_id": self.folder.name, "outcome": "pass", "summary": "synthetic",
                  "checked_inputs": ["parallel-a.md"], "findings": [], "limitations": []}
        worker.adapter.atomic_json(folder / "model-report.json", report)
        return {"returncode": 0, "session_id": session, "turn_completed": True, "turn_failed": False, "event_error": None, "stop_reason": None}

    def invoke(self):
        self.path.write_text(json.dumps(self.request), encoding="utf-8")
        with patch.object(worker, "gate", return_value=(self.config, self.capability)), patch.object(worker.adapter, "run_process", side_effect=self.fake_process) as process:
            worker.run(self.path)
            return process.call_count

    def test_explicit_resume_and_receipt_identity(self):
        self.request["session_id"] = str(uuid.uuid4())
        self.assertEqual(self.invoke(), 1)
        receipt = worker.load(self.folder / "result.json")
        self.assertEqual(receipt["status"], "completed")
        self.assertEqual(receipt["session_id"], self.request["session_id"])
        self.assertEqual(receipt["request_hash"], worker.adapter.sha(self.path))

    def test_duplicate_launch_marker_prevents_second_model_execution(self):
        self.invoke()
        with self.assertRaises(FileExistsError):
            self.invoke()

    def test_changed_input_hash_never_starts_a_process(self):
        self.request["contract"]["inputs"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "snapshot changed"):
            self.invoke()
        self.assertFalse((self.folder / "launched.json").exists())

    def test_private_repository_is_rejected(self):
        self.request["contract"]["repo_id"] = "private-example-repository"
        with self.assertRaisesRegex(ValueError, "synthetic"):
            self.invoke()
        self.assertFalse((self.folder / "launched.json").exists())

    def test_expired_host_heartbeat_never_starts_a_process(self):
        os.utime(self.folder / "heartbeat", (1, 1))
        with self.assertRaisesRegex(ValueError, "heartbeat expired"):
            self.invoke()
        self.assertFalse((self.folder / "launched.json").exists())

    def test_certification_change_rejected(self):
        saved = {"status": "passed", "capability": {"executable": "changed-codex"}, "policy_sha256": "policy"}
        with patch.object(worker, "config_load", return_value=self.config), patch.object(worker.adapter, "probe", return_value=self.capability), patch.object(worker, "load", return_value=saved):
            with self.assertRaisesRegex(ValueError, "recertification"):
                worker.gate()


if __name__ == "__main__":
    unittest.main()
