import hashlib
import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'framework'))
import prompt_snapshot

class PromptSnapshotTests(unittest.TestCase):
    def test_immutable_identity_and_role(self):
        snapshot={'role':'worker','revision':4,'text':'Version four','sha256':hashlib.sha256(b'Version four').hexdigest()}
        self.assertEqual(prompt_snapshot.text({'prompt':snapshot},'worker'),'Version four')
        with self.assertRaisesRegex(ValueError,'changed'):prompt_snapshot.text({'prompt':{**snapshot,'text':'Modified'}},'worker')
        with self.assertRaisesRegex(ValueError,'identity'):prompt_snapshot.text({'prompt':snapshot},'router')
        self.assertIn('normal persistent web conversation',prompt_snapshot.text({},'chat'))
    def test_large_deployment_prompt_with_unicode(self):
        content='合成🧪'*30000
        snapshot={'role':'worker','revision':1,'text':content,'sha256':hashlib.sha256(content.encode('utf-8')).hexdigest()}
        self.assertEqual(prompt_snapshot.text({'prompt':snapshot},'worker'),content)
