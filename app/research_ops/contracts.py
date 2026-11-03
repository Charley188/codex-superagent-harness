"""Validate untrusted task/report data before it reaches a process or state transition."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
from . import roles


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load(path):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "Duplicate JSON key: " + key)
            result[key] = value
        return result
    def constant(value):
        raise ValueError("Invalid JSON constant: " + value)
    return json.loads(Path(path).read_text(encoding="utf-8-sig"), object_pairs_hook=pairs, parse_constant=constant)


def safe_path(root, relative):
    require(isinstance(relative, str) and relative and not PurePosixPath(relative).is_absolute(), "Expected relative file path")
    require(not any(c in relative for c in "\\:\x00") and all(p not in ("", ".", "..") for p in relative.split("/")), "Unsafe file path")
    path = (root / relative).resolve()
    require(path.is_relative_to(root.resolve()), "Path escapes authorized root")
    return path


def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def task_card(card, config):
    fields = {"schema_version", "event_id", "repo_id", "kind", "objective", "inputs"}
    require(isinstance(card, dict) and fields <= set(card) <= fields | {"role"}, "Invalid task fields")
    require(type(card["schema_version"]) is int and card["schema_version"] == 1, "Unsupported task schema")
    for field in ("event_id", "repo_id", "objective"):
        require(isinstance(card[field], str) and 0 < len(card[field].strip()) <= (4000 if field == "objective" else 100), "Invalid " + field)
    require(card["kind"] in ("kb_check", "codex_review"), "Task kind not allowed")
    role = card.get("role", "general")
    roles.validate(role, card["kind"])
    require(card["repo_id"] in config["repositories"], "Unknown repository")
    if card["kind"] == "codex_review":
        require(config["repositories"][card["repo_id"]].get("allow_model_review") is True,
                "Model review is not enabled for this repository; explicit data-transfer authorization is required")
    require(isinstance(card["inputs"], list) and 0 < len(card["inputs"]) <= 20, "Provide 1-20 input files")
    root = Path(config["repositories"][card["repo_id"]]["root"]).resolve()
    inputs, total, seen = [], 0, set()
    for relative in card["inputs"]:
        path = safe_path(root, relative)
        require(path not in seen, "Duplicate input")
        seen.add(path)
        require(path.is_file() and path.suffix.lower() in (".md", ".txt", ".json", ".csv"), "Only existing text inputs are accepted")
        data = path.read_bytes()
        total += len(data)
        require(total <= 200_000, "Input context exceeds 200 KB budget")
        data.decode("utf-8-sig")
        inputs.append({"path": relative, "size_bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    result = {"schema_version": 1, "repo_id": card["repo_id"], "kind": card["kind"], "objective": card["objective"],
            "root": str(root), "permission": "read-only", "inputs": inputs,
            "policy_sha256": config["policy_sha256"]}
    # Preserve exact legacy payload identity when an old card omits role.
    if "role" in card:
        result.update(role=role, role_sha256=roles.fingerprint(role))
    return result


def verify_inputs(payload):
    for item in payload["inputs"]:
        path = safe_path(Path(payload["root"]), item["path"])
        require(path.is_file() and path.stat().st_size == item["size_bytes"] and sha(path) == item["sha256"], "Input changed/missing: " + item["path"])


REPORT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {"schema_version": {"type": "integer", "enum": [1]}, "task_id": {"type": "string"},
                   "attempt_id": {"type": "string"}, "outcome": {"type": "string", "enum": ["pass", "issues_found", "blocked"]},
                   "summary": {"type": "string"}, "checked_inputs": {"type": "array", "items": {"type": "string"}},
                   "findings": {"type": "array", "items": {"type": "string"}}, "limitations": {"type": "array", "items": {"type": "string"}}},
    "required": ["schema_version", "task_id", "attempt_id", "outcome", "summary", "checked_inputs", "findings", "limitations"]}


def validate_report(report, task, attempt, inputs):
    require(isinstance(report, dict) and set(report) == set(REPORT_SCHEMA["required"]), "Invalid report fields")
    require(type(report["schema_version"]) is int and report["schema_version"] == 1, "Invalid report schema")
    require(report["task_id"] == task and report["attempt_id"] == attempt, "Report task/attempt mismatch")
    require(report["outcome"] in ("pass", "issues_found", "blocked"), "Invalid report outcome")
    require(isinstance(report["summary"], str) and 0 < len(report["summary"]) <= 12000, "Invalid report summary")
    for key in ("checked_inputs", "findings", "limitations"):
        require(isinstance(report[key], list) and all(isinstance(v, str) and len(v) <= 12000 for v in report[key]), "Invalid report list: " + key)
    require(len(report["checked_inputs"]) == len(set(report["checked_inputs"])) and
            set(report["checked_inputs"]) <= {i["path"] for i in inputs}, "Report cites unknown/duplicate inputs")
    if report["outcome"] != "blocked":
        require(set(report["checked_inputs"]) == {i["path"] for i in inputs}, "Report omitted required inputs")
    return report
