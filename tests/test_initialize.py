import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class InitializeTests(unittest.TestCase):
    def test_fresh_install_and_existing_policy_are_separate(self):
        area = ROOT / 'state/test-tmp'
        area.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=area) as temporary:
            root = Path(temporary)
            (root / 'tools').mkdir()
            script = root / 'tools/initialize.py'
            shutil.copyfile(ROOT / 'tools/initialize.py', script)
            shutil.copytree(ROOT / 'tests/fixtures', root / 'tests/fixtures')
            result = subprocess.run([sys.executable, '-B', str(script), '--codex', 'example-codex'], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            before = (root / 'config.local.json').read_bytes()
            config = json.loads(before)
            self.assertEqual(config['codex'], 'example-codex')
            self.assertEqual(set(config['repositories']), {'synthetic-fixture', 'synthetic-paper'})
            for repo in config['repositories'].values():
                self.assertTrue(Path(repo['root']).is_relative_to(root))
                self.assertTrue(Path(repo['root']).is_dir())
            result = subprocess.run([sys.executable, '-B', str(script)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((root / 'config.local.json').read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
