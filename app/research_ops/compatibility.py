"""Behavioral certification: tests + actual read-only sandbox + exec and explicit resume."""
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid

from . import codex_adapter as adapter
from .contracts import load, require, sha


def certify(host):
    folder = host.state / "compatibility" / uuid.uuid4().hex
    folder.mkdir(parents=True)
    report = {"status": "failed", "policy_sha256": host.config["policy_sha256"], "started_unix": time.time(), "folder": str(folder)}
    try:
        capability = host.doctor()
        report["capability"] = capability
        tests = subprocess.run([sys.executable, "-B", "-m", "unittest", "discover", "-s", str(host.base / "app/tests"), "-v"],
                               cwd=host.base / "app", capture_output=True, timeout=90)
        (folder / "regression.log").write_bytes(tests.stdout + tests.stderr)
        require(tests.returncode == 0, "Host/adapter regression failed")
        report["regression_passed"] = True

        # Benign canaries in owned fixture directories; no user data targeted.
        sandbox = folder / "sandbox"
        sandbox.mkdir()
        external = folder / "outside"
        external.mkdir()
        script = sandbox / "probe.py"
        script.write_text('''import json,pathlib,subprocess,sys
paths=[pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2])]
blocked=[]
for p in paths:
    try:
        p.write_text('sandbox-canary',encoding='utf-8');blocked.append(False)
    except OSError:
        blocked.append(True)
child=subprocess.run([sys.executable,'-c',"import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('child-canary')",sys.argv[3]],capture_output=True)
print(json.dumps({'direct_writes_blocked':all(blocked),'child_write_blocked':child.returncode!=0}))
sys.exit(0 if all(blocked) and child.returncode!=0 else 3)
''', encoding="utf-8")
        targets = [sandbox / "direct.txt", external / "absolute.txt", external / "child.txt"]
        result = subprocess.run([capability["executable"], "sandbox", "--permission-profile", ":read-only", "-C", str(sandbox),
                                 sys.executable, "-B", str(script), *map(str, targets)], capture_output=True, timeout=45)
        (folder / "sandbox.stdout.log").write_bytes(result.stdout)
        (folder / "sandbox.stderr.log").write_bytes(result.stderr)
        require(result.returncode == 0 and not any(p.exists() for p in targets), "Sandbox boundary probe failed")
        sandbox_result = json.loads(result.stdout.decode("utf-8-sig"))
        require(sandbox_result == {"direct_writes_blocked": True, "child_write_blocked": True}, "Sandbox behavior not verified")
        report["sandbox"] = sandbox_result

        inputs = [{"path": "fixture.txt", "sha256": "fixture"}]
        task_id, session = str(uuid.uuid4()), None
        turns = []
        for number in (1, 2):
            attempt = str(uuid.uuid4())
            turn = folder / ("first" if number == 1 else "resume")
            turn.mkdir()
            schema, output = turn / "schema.json", turn / "report.json"
            adapter.atomic_json(schema, adapter.REPORT_SCHEMA)
            prompt = ("Compatibility fixture only. Do not call any tools, read files or write anything. "
                      "The complete input fixture.txt is: 'This is a synthetic compatibility test.' "
                      "Return JSON with schema_version=1, outcome=pass, summary='compatibility fixture', checked_inputs=['fixture.txt'], "
                      "findings=[], limitations=['synthetic test only'], task_id=" + task_id + ", attempt_id=" + attempt + ".")
            result = adapter.run_process(adapter.command(capability, sandbox, schema, output, session), sandbox, turn, prompt,
                                         min(host.config["timeout_seconds"], 120))
            claim = {"task_id": task_id, "attempt_id": attempt, "payload": {"inputs": inputs}}
            adapter.validated_result(result, output, claim)
            if session:
                require(result["session_id"] == session, "Explicit resume did not preserve the task session")
            session = result["session_id"]
            turns.append(result)
        report["live_turns"] = turns
        report["status"] = "passed"
    except (ValueError, OSError, subprocess.SubprocessError, RuntimeError) as exc:
        report["error"] = str(exc)
    report["finished_unix"] = time.time()
    adapter.atomic_json(folder / "result.json", report)
    adapter.atomic_json(host.state / "compatibility-accepted.json", report)
    return report
