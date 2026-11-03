"""Real local job/process tests; all files are synthetic and below state/dsh-core."""
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import unittest
import uuid

HERE=Path(__file__).resolve().parents[1];BASE=HERE.parents[1]
sys.path.insert(0,str(HERE/'framework'))
import execution_worker
import model_worker

def alive(pid):
    if os.name!='nt':
        try: os.kill(pid,0);return True
        except ProcessLookupError:return False
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.OpenProcess.restype=ctypes.c_void_p;kernel.OpenProcess.argtypes=[ctypes.c_ulong,ctypes.c_int,ctypes.c_ulong]
    kernel.GetExitCodeProcess.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_ulong)];kernel.CloseHandle.argtypes=[ctypes.c_void_p]
    handle=kernel.OpenProcess(0x1000,False,pid)
    if not handle:return False
    code=ctypes.c_ulong();kernel.GetExitCodeProcess(handle,ctypes.byref(code));kernel.CloseHandle(handle)
    return code.value==259

class JobTests(unittest.TestCase):
    def test_timeout_is_distinguished_from_generic_worker_failure(self):
        self.assertIn('120',execution_worker.turn_failure({'stop_reason':'timeout'},120))
        self.assertIn('已取消',execution_worker.turn_failure({'stop_reason':'cancelled'},120))
    def test_writer_conflict_requires_terminal_pre_turn_evidence(self):
        folder=BASE/'state/dsh-core/process-tests'/str(uuid.uuid4());folder.mkdir(parents=True)
        try:
            session=str(uuid.uuid4());(folder/'events.jsonl').write_text('');(folder/'stderr.log').write_text('thread '+session+' already has an active writer')
            result={'returncode':1,'session_id':None,'turn_completed':False,'turn_failed':False,'event_error':None,'stop_reason':None}
            self.assertTrue(model_worker.session_writer_conflict(folder,result,session))
            self.assertFalse(model_worker.session_writer_conflict(folder,{**result,'stop_reason':'timeout'},session))
            (folder/'events.jsonl').write_text('{"type":"thread.started"}')
            self.assertFalse(model_worker.session_writer_conflict(folder,result,session))
        finally: shutil.rmtree(folder)
    def setUp(self):
        self.root=BASE/'state/dsh-core/process-tests'/str(uuid.uuid4());self.root.mkdir(parents=True)
    def tearDown(self):
        # Explicitly verified test-owned subtree; retain failures in normal runtime, not these disposable fixtures.
        self.assertTrue(self.root.resolve().is_relative_to((BASE/'state/dsh-core/process-tests').resolve()))
        shutil.rmtree(self.root)
    def request(self,code,timeout=3,artifacts=None):
        folder=self.root/str(uuid.uuid4());folder.mkdir()
        request={'id':folder.name,'profile':{'argv':[sys.executable,'-B','-c',code], 'timeout_seconds':timeout,'artifacts':artifacts or []}}
        path=folder/'request.json';path.write_text(json.dumps(request),encoding='utf-8');(folder/'heartbeat').touch()
        return folder,path
    def run_job(self,code,timeout=3,artifacts=None):
        folder,path=self.request(code,timeout,artifacts)
        result=subprocess.run([sys.executable,'-B',str(HERE/'framework/job_worker.py'),'--request',str(path)],capture_output=True,text=True,timeout=20)
        self.assertEqual(result.returncode,0,result.stderr)
        return folder,json.loads((folder/'result.json').read_text())
    def test_artifact_hash_and_success(self):
        folder,r=self.run_job("from pathlib import Path;Path('result.txt').write_text('synthetic')",artifacts=['result.txt'])
        self.assertEqual(r['status'],'completed');self.assertEqual(r['artifacts'][0]['sha256'],hashlib.sha256(b'synthetic').hexdigest())
    def test_missing_artifact_is_not_success(self):
        _,r=self.run_job('print(42)',artifacts=['missing.txt']);self.assertEqual(r['status'],'failed')
    def test_timeout_stops_child_tree(self):
        code="import subprocess,sys,time;from pathlib import Path;p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);Path('pid').write_text(str(p.pid));time.sleep(60)"
        folder,r=self.run_job(code,timeout=.5)
        self.assertEqual(r['reason'],'timeout');self.assertFalse(alive(int((folder/'output/pid').read_text())))
    def test_cancel_before_tool_progress(self):
        folder,path=self.request('import time;time.sleep(60)');(folder/'cancel').touch()
        p=subprocess.run([sys.executable,'-B',str(HERE/'framework/job_worker.py'),'--request',str(path)],capture_output=True,text=True,timeout=10)
        self.assertEqual(p.returncode,0,p.stderr);self.assertEqual(json.loads((folder/'result.json').read_text())['status'],'cancelled')
    def test_expired_host_lease_stops_real_running_tree(self):
        folder,path=self.request('import time;time.sleep(60)',timeout=60)
        p=subprocess.Popen([sys.executable,'-B',str(HERE/'framework/job_worker.py'),'--request',str(path)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            deadline=time.time()+8
            while not (folder/'process.json').exists() and time.time()<deadline:time.sleep(.05)
            self.assertTrue((folder/'process.json').exists())
            pid=json.loads((folder/'process.json').read_text())['pid'];self.assertTrue(alive(pid))
            os.utime(folder/'heartbeat',(time.time()-30,time.time()-30))
            _,err=p.communicate(timeout=8);self.assertEqual(p.returncode,0,err)
            self.assertEqual(json.loads((folder/'result.json').read_text())['reason'],'lease_lost');self.assertFalse(alive(pid))
        finally:
            if p.poll() is None:p.kill();p.wait()
    def test_independent_monitor_records_host_failure(self):
        (self.root/'monitor-input.json').write_text(json.dumps({'at':time.time()-50,'executions':[]}))
        p=subprocess.run([sys.executable,'-B',str(HERE/'framework/monitor.py'),'--directory',str(self.root),'--stale','1'],capture_output=True,text=True,timeout=8)
        self.assertEqual(p.returncode,0,p.stderr);status=json.loads((self.root/'monitor-status.json').read_text());self.assertFalse(status['healthy']);self.assertEqual(status['alerts'][0]['kind'],'host_unresponsive')
    def test_read_scope_rejects_traversal(self):
        with self.assertRaises(ValueError):execution_worker.safe(self.root,'../../config.local.json')
    def test_generated_paths_reject_escape_protected_names_and_windows_aliases(self):
        for name in ('../escape.py','C:/escape.py','sub/../../escape.py','.git/config','.codex/a','host-input-manifest.json','NUL.txt','CON','file.py:stream','sub\\escape.py','test.py.','test.py '):
            with self.subTest(name=name):
                with self.assertRaises(ValueError):execution_worker.generated_changes(self.root,[{'path':name,'content':'x'}])
        self.assertEqual(execution_worker.generated_changes(self.root,[{'path':'rtl/filter.sv','content':'module filter;endmodule'}])[0][0],(self.root/'rtl/filter.sv').resolve())
    def test_duplicate_generated_files_rejected_before_any_apply(self):
        files=[{'path':'test.py','content':'a'},{'path':'test.py','content':'b'}]
        with self.assertRaises(ValueError):execution_worker.generated_changes(self.root,files)
        self.assertFalse((self.root/'test.py').exists())

if __name__=='__main__':unittest.main()
