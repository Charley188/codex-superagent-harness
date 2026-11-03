import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'framework'))
from workspace_access import WorkspaceAccess

class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name);self.root=self.base/'source';self.root.mkdir()
        self.work=self.base/'work';self.work.mkdir()
        self.access=WorkspaceAccess(self.root,self.base/'audit',self.work)

    def test_read_new_revision_in_same_session_and_receipts(self):
        p=self.root/'新版.docx'
        def revision(value):
            with zipfile.ZipFile(p,'w') as z:z.writestr('word/document.xml','<w:document xmlns:w="urn:word"><w:p><w:t>'+value+'</w:t></w:p></w:document>')
        revision('version one');a=self.access.read(str(p))
        revision('version two');b=self.access.read(str(p))
        self.assertEqual(a['text'],'version one');self.assertEqual(b['text'],'version two')
        self.assertNotEqual(a['sha256'],b['sha256'])
        self.assertEqual(len(list((self.base/'audit/versions').iterdir())),2)
        self.assertEqual(len((self.base/'audit/access.jsonl').read_text().splitlines()),2)

    def test_new_files_and_pagination(self):
        (self.root/'a.txt').write_text('abcdef')
        self.assertEqual(self.access.read('a.txt',2,2)['text'],'cd')
        self.assertEqual(self.access.read('a.txt',2,2)['next_offset'],4)
        for n in range(205):(self.root/('file-%03d.txt'%n)).write_text('x')
        self.assertEqual(self.access.list()['next_offset'],200)
        self.assertEqual(len(self.access.list(offset=200)['entries']),6)
        self.assertIn('file-204.txt',self.access.search('204')['matches'])

    def test_scope_and_excluded_paths(self):
        (self.base/'outside.txt').write_text('outside');(self.root/'.env').write_text('token')
        for p in ['../outside.txt',str(self.base/'outside.txt'),'.env']:
            with self.assertRaises(ValueError):self.access.read(p)
        with self.assertRaises(ValueError):self.access.read('x',offset=-1)
        with self.assertRaises(ValueError):self.access.call('project_run',{})

    def test_independent_copies_preserve_edits_and_live_source(self):
        (self.root/'a.py').write_text('old')
        self.access.checkout('a.py');(self.work/'a.py').write_text('worker A')
        (self.root/'a.py').write_text('new')
        self.assertFalse(self.access.checkout('a.py')['copied'])
        second=self.base/'work-b';second.mkdir()
        WorkspaceAccess(self.root,self.base/'audit-b',second).checkout('a.py')
        self.assertEqual((self.work/'a.py').read_text(),'worker A')
        self.assertEqual((second/'a.py').read_text(),'new')
        self.assertEqual(self.access.read('a.py')['text'],'new')
        with self.assertRaises(ValueError):WorkspaceAccess(self.root,self.base/'read-audit').checkout('a.py')

    def test_stdio_mcp_roundtrip(self):
        (self.root/'a.txt').write_text('MCP_LIVE')
        script=Path(__file__).resolve().parents[1]/'framework/workspace_mcp.py'
        requests=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05'}},
          {'jsonrpc':'2.0','method':'notifications/initialized'},
          {'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'project_read','arguments':{'path':'a.txt'}}},
          {'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'project_read','arguments':{'path':'../outside.txt'}}}]
        r=subprocess.run([sys.executable,'-B',str(script),'--root',str(self.root),'--audit',str(self.base/'stdio')],
            input='\n'.join(json.dumps(v) for v in requests)+'\n',text=True,encoding='utf-8',capture_output=True,timeout=10)
        self.assertEqual(r.returncode,0,r.stderr)
        replies=[json.loads(line) for line in r.stdout.splitlines()]
        self.assertIn('MCP_LIVE',replies[1]['result']['content'][0]['text'])
        self.assertTrue(replies[2]['result']['isError'])

if __name__=='__main__':unittest.main()
