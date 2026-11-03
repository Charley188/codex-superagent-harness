"""Host-owned review roles; they select a lens, never expand runtime permissions."""
import hashlib
import json

ROLES = {
    "general": {"label": "通用审阅（兼容旧任务）", "kinds": ["kb_check", "codex_review"],
                "instructions": "Review consistency and scope of the supplied text. Do not infer missing evidence."},
    "knowledge": {"label": "知识整理", "kinds": ["kb_check", "codex_review"],
                  "instructions": "Review definitions, assumptions, internal consistency, duplication and links named in the supplied text. Suggest changes in the report only."},
    "engineering": {"label": "工程检查", "kinds": ["codex_review"],
                    "instructions": "Review described interfaces, versions and validation levels. Distinguish generated code, simulation, implementation, timing closure and hardware measurements. Do not run builds or tools."},
    "experiment": {"label": "实验分析审阅", "kinds": ["codex_review"],
                   "instructions": "Review described inputs, units, repeat counts, masks, alignment and uncertainty. Distinguish actual measurements, simulations and predictions. Do not claim a new numerical analysis."},
    "paper": {"label": "论文证据审阅", "kinds": ["codex_review"],
              "instructions": "Review whether stated claims follow from the supplied evidence and conditions. Identify unsupported generalizations. Do not invent citations or certify novelty."}
}


def definition(name):
    if not isinstance(name, str) or name not in ROLES:
        raise ValueError("Unknown worker role")
    return {**ROLES[name], "permission": "read-only", "tools": "none", "output": "structured_report_only"}


def fingerprint(name):
    return hashlib.sha256(json.dumps(definition(name), sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def validate(name, kind):
    spec = definition(name)
    if kind not in spec["kinds"]:
        raise ValueError("Task kind is not permitted for worker role " + name)
    return spec
