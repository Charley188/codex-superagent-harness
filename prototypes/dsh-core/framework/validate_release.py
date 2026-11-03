"""Portable provenance audit; independent of the author's private state."""
import hashlib
import json
from pathlib import Path
HERE = Path(__file__).resolve().parents[1]
BASE = HERE.parents[1]
manifest = json.loads((HERE / 'upstream-manifest.json').read_text(encoding='utf-8'))
for row in manifest['files']:
    path = HERE / 'vendor/dsh' / row['path']
    assert hashlib.sha256(path.read_bytes()).hexdigest() == row['sha256'], str(path)
harness = HERE / 'panel/upstream-harness'
harness_manifest = json.loads((harness / 'manifest.json').read_text(encoding='utf-8'))
for row in harness_manifest['files']:
    assert hashlib.sha256((harness / row['path']).read_bytes()).hexdigest() == row['sha256'], row['path']
config = json.loads((BASE / 'config.local.json').read_text(encoding='utf-8'))
for key, directory in [('synthetic-fixture', 'synthetic-review'), ('synthetic-paper', 'synthetic-paper')]:
    repo = config['repositories'][key]
    assert Path(repo['root']).resolve() == (BASE / 'state/fixtures' / directory).resolve()
    assert repo.get('allow_model_review') is True
print(json.dumps({'status': 'passed', 'upstream_files_verified': len(manifest['files']),
    'harness_files_verified': len(harness_manifest['files']),
    'scope': 'Public source provenance and synthetic configuration; no private continuity claim'}))
