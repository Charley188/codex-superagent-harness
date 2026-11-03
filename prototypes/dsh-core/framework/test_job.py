"""Registered local unittest profile. Test stdout is evidence, not an agent's success claim."""
import json
from pathlib import Path
import subprocess
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from durable_worker import gate
workspace,output=map(Path,sys.argv[1:])
config,capability=gate()
# Generated tests are untrusted code. Reuse the certified direct/child read-only boundary, not just a prompt.
result=subprocess.run([capability['executable'],'sandbox','--permission-profile',':read-only','-C',str(workspace),sys.executable,'-B','-m','unittest','discover','-v'],cwd=workspace,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=45)
text=result.stdout+result.stderr
(output/'tests.log').write_text(text,encoding='utf-8')
passed=result.returncode==0 and 'Ran 0 tests' not in text and 'Ran ' in text
(output/'verification.json').write_text(json.dumps({'passed':passed,'exit_code':result.returncode,'log':'tests.log'}),encoding='utf-8')
sys.exit(0 if passed else 1)
