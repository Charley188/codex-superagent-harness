import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from research_ops import codex_adapter as adapter
from research_ops.contracts import task_card, sha
from research_ops.host import Host, config_load
from research_ops.pool import run_batch
from research_ops import roles


class PoolTests(unittest.TestCase):
    def setUp(self):
        parent = Path(__file__).resolve().parents[2] / "state/test-tmp"
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="pool-", dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        repositories = {}
        for repo in ("a", "b", "c"):
            root = self.base / ("repo-" + repo)
            root.mkdir()
            (root / "note.md").write_text("Synthetic review input", encoding="utf-8")
            repositories[repo] = {"root": str(root), "allow_model_review": True}
        self.config = {"schema_version": 1, "max_workers": 2, "max_attempts": 3, "timeout_seconds": 60,
                       "repositories": repositories, "policy_sha256": "fixture"}
        self.host = Host(self.config, self.base / "runtime")
        self.addCleanup(self.host.close)

    def submit(self, event, repo="a", role="knowledge", kind="kb_check"):
        card = {"schema_version": 1, "event_id": event, "repo_id": repo, "kind": kind,
                "objective": "synthetic check", "inputs": ["note.md"]}
        if role is not None:
            card["role"] = role
        payload = task_card(card, self.config)
        return self.host.store.enqueue(event, payload)[0]

    def test_legacy_card_retains_exact_payload_shape(self):
        task = self.submit("legacy", role=None)
        payload = json.loads(self.host.store.get(task)["payload"])
        self.assertNotIn("role", payload)
        self.assertNotIn("role_sha256", payload)

    def test_roles_cannot_add_tools_or_commands(self):
        for role in roles.ROLES:
            spec = roles.definition(role)
            self.assertEqual(spec["permission"], "read-only")
            self.assertEqual(spec["tools"], "none")
        with self.assertRaises(ValueError):
            self.submit("bad-role", role="administrator")
        with self.assertRaises(ValueError):
            self.submit("bad-kind", role="engineering", kind="kb_check")

    def test_prompt_contains_host_role_and_schema_boundaries(self):
        task = self.submit("paper", role="paper", kind="codex_review")
        payload = json.loads(self.host.store.get(task)["payload"])
        args, prompt, _ = adapter.execute({"executable": "codex"}, {"task_id": task, "attempt_id": "attempt", "payload": payload}, self.base, None, None)
        self.assertIn(roles.definition("paper")["instructions"], prompt)
        self.assertIn("read-only", args)
        self.assertNotIn("--add-dir", args)

    def test_changed_role_rejected_before_execution(self):
        task = self.submit("stale-role")
        with patch.object(Host, "gate", return_value={}), patch.object(roles, "fingerprint", return_value="changed"), patch.object(Host, "kb_check") as check:
            self.assertEqual(self.host.run_once()["state"], "failed")
            check.assert_not_called()

    def test_same_physical_root_cannot_bypass_lock(self):
        config = {k: v for k, v in self.config.items() if k != "policy_sha256"}
        for replacement in (self.config["repositories"]["a"]["root"], str(Path(self.config["repositories"]["a"]["root"]) / "nested")):
            Path(replacement).mkdir(exist_ok=True)
            config["repositories"]["b"]["root"] = replacement
            file = self.base / "config.json"
            file.write_text(json.dumps(config), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "overlap"):
                config_load(file)

    def test_batch_parallelizes_distinct_repos_and_serializes_same_repo(self):
        tasks = [self.submit("a1"), self.submit("a2"), self.submit("b1", "b")]
        lock, active, maximum, observed = threading.Lock(), set(), [0], []
        def check(local, claim, folder, cancelled):
            repo = claim["payload"]["repo_id"]
            with lock:
                self.assertNotIn(repo, active)
                active.add(repo)
                maximum[0] = max(maximum[0], len(active))
                observed.append(claim["task_id"])
            time.sleep(0.15)
            with lock:
                active.remove(repo)
            return {"synthetic": True}
        with patch.object(Host, "gate", return_value={}), patch.object(Host, "kb_check", check):
            result = run_batch(self.host, 2, 3)
        self.assertEqual(result["status"], "finished")
        self.assertEqual(maximum[0], 2)
        self.assertCountEqual(observed, tasks)
        self.assertEqual(len(set(observed)), 3)
        self.assertTrue(all(self.host.store.get(t)["state"] == "ready-for-review" for t in tasks))

    def test_one_failure_does_not_requeue_or_block_other_repo(self):
        bad, good = self.submit("bad"), self.submit("good", "b")
        def check(local, claim, folder, cancelled):
            if claim["task_id"] == bad:
                raise ValueError("synthetic failure")
            return {"synthetic": True}
        with patch.object(Host, "gate", return_value={}), patch.object(Host, "kb_check", check):
            result = run_batch(self.host, 2, 2)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(self.host.store.get(good)["state"], "ready-for-review")
        self.assertEqual(self.host.store.get(bad)["generation"], 1)
        self.assertEqual(self.host.store.db.execute("SELECT count(*) FROM locks").fetchone()[0], 0)

    def test_newly_submitted_tasks_wait_for_next_batch(self):
        first = self.submit("first")
        submitted = []
        def check(local, claim, folder, cancelled):
            payload = dict(claim["payload"])
            submitted.append(local.store.enqueue("late", payload)[0])
            return {"synthetic": True}
        with patch.object(Host, "gate", return_value={}), patch.object(Host, "kb_check", check):
            result = run_batch(self.host, 1, 4)
        self.assertEqual(list(result["snapshot_generations"]), [first])
        self.assertEqual(self.host.store.get(submitted[0])["state"], "queued")

    def test_task_budget_and_role_filter(self):
        paper = self.submit("p", role="paper", kind="codex_review")
        a, b = self.submit("a"), self.submit("b", "b")
        with patch.object(Host, "gate", return_value={}), patch.object(Host, "kb_check", return_value={}):
            result = run_batch(self.host, 1, 1, ["knowledge"])
        self.assertEqual(set(result["snapshot_generations"]), {a})
        self.assertEqual(self.host.store.get(b)["state"], "queued")
        self.assertEqual(self.host.store.get(paper)["state"], "queued")

    def test_pause_does_not_claim_and_bad_limits_rejected(self):
        task = self.submit("a")
        self.host.store.paused(True)
        with patch.object(Host, "gate", return_value={}):
            result = run_batch(self.host, 2, 2)
            self.assertEqual(result["status"], "incomplete")
            for workers, limit in ((3, 1), (0, 1), (1, 0), (1, 21)):
                with self.assertRaises(ValueError):
                    run_batch(self.host, workers, limit)
        self.assertEqual(self.host.store.get(task)["generation"], 0)

    def test_batch_stop_cancels_running_and_leaves_unclaimed(self):
        running, unclaimed = self.submit("a1"), self.submit("a2")
        stop = threading.Event()
        def check(local, claim, folder, cancelled):
            stop.set()
            return {"synthetic": True}
        with patch.object(Host, "gate", return_value={}), patch.object(Host, "kb_check", check):
            result = run_batch(self.host, 1, 2, stop_event=stop)
        self.assertTrue(result["stopped"])
        self.assertEqual(self.host.store.get(running)["state"], "cancelled")
        self.assertEqual(self.host.store.get(unclaimed)["state"], "queued")

    def test_batch_snapshot_never_executes_a_new_retry_generation(self):
        task = self.submit("a")
        old = {task: 0}
        attempt = self.host.store.claim("w", expected_generations=old)
        self.host.store.finish(attempt["attempt_id"], "failed")
        self.host.store.retry(task)
        self.assertIsNone(self.host.store.claim("w", expected_generations=old))
        self.assertIsNotNone(self.host.store.claim("w", expected_generations={task: 1}))


if __name__ == "__main__":
    unittest.main()
