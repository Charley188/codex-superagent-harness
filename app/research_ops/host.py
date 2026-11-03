"""Trusted host policy, finite work invocation, compatibility gates, local status view."""
import html
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

from . import codex_adapter as adapter
from .contracts import load, require, sha, task_card, verify_inputs
from .store import Store, digest
from . import roles

BASE = Path(__file__).resolve().parents[2]


def config_load(path):
    raw = load(path)
    require(raw.get("schema_version") == 1 and isinstance(raw.get("repositories"), dict), "Invalid host config")
    require(type(raw.get("max_workers")) is int and 1 <= raw["max_workers"] <= 4, "max_workers must be 1..4")
    require(type(raw.get("timeout_seconds")) is int and 15 <= raw["timeout_seconds"] <= 600, "Invalid finite timeout")
    require(type(raw.get("max_attempts")) is int and 1 <= raw["max_attempts"] <= 5, "Invalid attempt budget")
    roots = []
    for repo in raw["repositories"].values():
        require(isinstance(repo, dict) and isinstance(repo.get("root"), str), "Repository needs a root path")
        root = Path(repo["root"]).resolve()
        require(root.is_dir(), "Repository root does not exist")
        require(not any(root.is_relative_to(other) or other.is_relative_to(root) for other in roots),
                "Repository roots overlap; aliases must not bypass per-repository locks")
        roots.append(root)
    raw["policy_sha256"] = digest(raw)
    return raw


class Host:
    def __init__(self, config, base=BASE):
        self.config, self.base = config, Path(base)
        self.state = self.base / "state"
        self.workspaces = self.base / "workspaces"
        self.state.mkdir(parents=True, exist_ok=True)
        self.workspaces.mkdir(parents=True, exist_ok=True)
        self.store = Store(self.state / "queue.sqlite3")

    def close(self):
        self.store.close()

    def submit(self, path):
        card = load(path)
        payload = task_card(card, self.config)
        return self.store.enqueue(card["event_id"], payload)

    def doctor(self):
        capability = adapter.probe(self.config.get("codex", "codex"))
        adapter.atomic_json(self.state / "compatibility-probe.json", capability)
        return capability

    def gate(self):
        capability = self.doctor()
        approval = self.state / "compatibility-accepted.json"
        require(approval.is_file(), "Codex compatibility not certified; queue preserved. Run certify first")
        saved = load(approval)
        require(saved.get("capability") == capability and saved.get("policy_sha256") == self.config["policy_sha256"]
                and saved.get("status") == "passed", "Codex/adapter/policy changed; compatibility recertification required, queue preserved")
        return capability

    def run_once(self, expected_generations=None, selected_roles=None, stop_event=None, worker_id=None):
        # Probe/gate before claiming: an incompatible release leaves queued work untouched.
        capability = self.gate()
        if stop_event is not None and stop_event.is_set():
            return {"state": "batch_stopped"}
        claim = self.store.claim(worker_id or str(uuid.uuid4()), self.config["max_workers"],
                                 expected_generations=expected_generations, roles=selected_roles)
        if claim is None:
            return {"state": "idle_or_paused_or_locked"}
        folder = self.workspaces / claim["task_id"] / claim["attempt_id"]
        folder.mkdir(parents=True, exist_ok=False)
        adapter.atomic_json(folder / "task-snapshot.json", claim)
        cancelled = lambda: self.store.cancellation_requested(claim["task_id"]) or (stop_event is not None and stop_event.is_set())
        try:
            payload = claim["payload"]
            require(payload["policy_sha256"] == self.config["policy_sha256"], "Task authorization snapshot differs from current policy")
            role = payload.get("role", "general")
            roles.validate(role, payload["kind"])
            if "role_sha256" in payload:
                require(payload["role_sha256"] == roles.fingerprint(role), "Worker role definition changed; resubmit reviewed task")
            verify_inputs(payload)
            if payload["kind"] == "kb_check":
                report = self.kb_check(claim, folder, cancelled)
            else:
                args, prompt, output = adapter.execute(capability, claim, folder, None, None)
                result = adapter.run_process(args, folder, folder, prompt, self.config["timeout_seconds"],
                    heartbeat=lambda: self.store.heartbeat(claim["attempt_id"]),
                    cancel=cancelled,
                    on_session=lambda s: self.store.bind_session(claim["attempt_id"], s))
                if result["stop_reason"] == "cancelled":
                    self.store.finish(claim["attempt_id"], "cancelled")
                    return {"task_id": claim["task_id"], "state": "cancelled"}
                report = adapter.validated_result(result, output, claim)
            verify_inputs(payload)
            if cancelled():
                self.store.finish(claim["attempt_id"], "cancelled")
                return {"task_id": claim["task_id"], "state": "cancelled"}
            adapter.atomic_json(folder / "validated-report.json", report)
            self.store.finish(claim["attempt_id"], "ready-for-review", report)
        except adapter.ProcessUncertain:
            # Unknown stop keeps the lease/lock for explicit recovery.
            raise
        except Exception as exc:
            self.store.finish(claim["attempt_id"], "failed", error=str(exc))
        except KeyboardInterrupt:
            self.store.finish(claim["attempt_id"], "interrupted", error="Host interrupted after executor stop")
            raise
        return {"task_id": claim["task_id"], "state": self.store.get(claim["task_id"])["state"], "folder": str(folder)}

    def kb_check(self, claim, folder, cancelled=None):
        payload = claim["payload"]
        repository = self.config["repositories"][payload["repo_id"]]
        pinned = repository.get("trusted_checker_files", {})
        require(set(pinned) == {"scripts/kb.py", "scripts/evidence.py"}, "Trusted checker is not pinned")
        for name, expected in pinned.items():
            require(sha(Path(payload["root"]) / name) == expected, "Trusted checker changed: " + name)
        # Fixed invocation; task text can never replace the command or its arguments.
        args = [sys.executable, "-B", str(Path(payload["root"]) / "scripts/kb.py"), "check"]
        options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}
        with (folder / "checker.stdout.log").open("wb") as out, (folder / "checker.stderr.log").open("wb") as err:
            process = subprocess.Popen(args, cwd=payload["root"], stdout=out, stderr=err, **options)
            adapter.attach(process)
            started = time.monotonic()
            try:
                while process.poll() is None:
                    if (cancelled and cancelled()) or self.store.cancellation_requested(claim["task_id"]):
                        self.store.cancel(claim["task_id"])
                        adapter.stop_process(process)
                        raise ValueError("Cancelled")
                    if time.monotonic() - started > self.config["timeout_seconds"]:
                        adapter.stop_process(process)
                        raise ValueError("Checker timed out")
                    require(self.store.heartbeat(claim["attempt_id"]), "Lease lost")
                    time.sleep(0.2)
            except BaseException:
                adapter.stop_process(process)
                raise
            finally:
                adapter.close_job(process)
        stdout = (folder / "checker.stdout.log").read_text(encoding="utf-8", errors="replace")
        passed = process.returncode == 0 and "CHECK PASS:" in stdout
        require(passed, "Knowledge-base check failed or success report missing; inspect logs")
        return {"schema_version": 1, "task_id": claim["task_id"], "attempt_id": claim["attempt_id"], "outcome": "pass",
                "summary": stdout.strip(), "checked_inputs": [i["path"] for i in payload["inputs"]],
                "findings": [], "limitations": ["Deterministic metadata/link/hash checks; no scientific or hardware acceptance."]}

    def status_html(self):
        rows = "".join("<tr>" + "".join("<td>" + html.escape(str(row[key] or "")) + "</td>" for key in
                        ("event_id", "role", "repo_id", "state", "generation", "session_id", "id")) + "</tr>" for row in self.store.list())
        page = ('<!doctype html><html lang="zh"><meta charset="utf-8"><title>Research Ops 任务状态</title>'
                '<style>body{font:16px system-ui;margin:32px;color:#243244}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:left}table{border-collapse:collapse}h1{font-size:24px}</style>'
                '<h1>Research Ops 任务状态</h1><p>手动生成的本地快照；待审查不等于已完成。刷新请重新运行 status。</p>'
                '<table><tr><th>任务</th><th>角色</th><th>仓库</th><th>状态</th><th>尝试次数</th><th>会话</th><th>任务编号</th></tr>' + rows + '</table></html>')
        path = self.state / "status.html"
        path.write_text(page, encoding="utf-8")
        return path
