"""Initialize an independent installation using public synthetic fixtures only."""
import argparse
import json
from pathlib import Path
import shutil
BASE = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--codex', default='codex')
args = parser.parse_args()
config = BASE / 'config.local.json'
if config.exists():
    raise SystemExit('Configuration already exists; refusing to overwrite local policy.')
repositories = {}
for repo, directory in [('synthetic-fixture', 'synthetic-review'), ('synthetic-paper', 'synthetic-paper')]:
    destination = BASE / 'state/fixtures' / directory
    if destination.exists():
        raise SystemExit('Fixture destination exists; refusing to overwrite: ' + str(destination))
    shutil.copytree(BASE / 'tests/fixtures' / directory, destination)
    repositories[repo] = {'root': str(destination.resolve()), 'allow_model_review': True}
config.write_text(json.dumps({'schema_version': 1, 'codex': args.codex,
    'max_workers': 4, 'max_attempts': 3, 'timeout_seconds': 120,
    'repositories': repositories}, indent=2) + '\n', encoding='utf-8')
print('Created local policy and synthetic fixtures. No certification or user project has been imported.')
