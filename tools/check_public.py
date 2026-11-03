"""Check tracked publication content without printing secret values."""
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode('utf-8').split('\0')[:-1]
if not paths:
    raise SystemExit('No tracked files to audit. Stage the intended source first.')
forbidden_dirs = {'state', 'workspaces', 'reference', 'node_modules', '__pycache__', '.codex', '.aws', '.ssh'}
forbidden_names = {'config.local.json', 'connection.json', 'auth.json', '.env'}
forbidden_suffixes = {'.exe', '.dll', '.sqlite', '.sqlite3', '.db', '.log', '.pyc', '.lnk'}
secret = re.compile(r'github_pat_[A-Za-z0-9_]{15,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{25,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----')
issues = []
for name in paths:
    p = Path(name)
    if (any(part in forbidden_dirs for part in p.parts) or p.name in forbidden_names
            or p.name.startswith('.env.') or p.suffix.lower() in forbidden_suffixes):
        issues.append({'path': name, 'reason': 'runtime/private/generated file'})
    try:
        text = (ROOT / name).read_bytes().decode('utf-8')
    except (UnicodeError, OSError):
        issues.append({'path': name, 'reason': 'missing or non-text source; review explicitly'})
        continue
    if secret.search(text):
        issues.append({'path': name, 'reason': 'possible credential; value omitted'})
print(json.dumps({'tracked_files': len(paths), 'issues': issues}, ensure_ascii=False))
raise SystemExit(1 if issues else 0)
