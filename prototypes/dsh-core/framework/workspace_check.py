"""Certify isolated synthetic workspace execution for this exact Codex and worker adapter."""
import json
from pathlib import Path
import sys
import uuid
from execution_worker import BASE, adapter, gate, workspace_fingerprint

def check():
    config, capability=gate()
    folder=BASE/'state/dsh-core/workspace-checks'/str(uuid.uuid4()); folder.mkdir(parents=True)
    workspace=folder/'workspace'; workspace.mkdir()
    (workspace/'input.txt').write_text('Pure synthetic test: 2 + 3 = 5.\n',encoding='utf-8')
    schema={'type':'object','additionalProperties':False,'properties':{'answer':{'type':'integer'},'tested':{'type':'boolean'}},'required':['answer','tested']}
    adapter.atomic_json(folder/'schema.json',schema)
    args=adapter.command(capability,workspace,folder/'schema.json',folder/'output.json'); args[args.index('--sandbox')+1]='workspace-write'
    prompt='Synthetic compatibility test. Inside your current workspace create addition.py with a function add(a,b), create test_addition.py using unittest to assert add(2,3)==5, and run that unittest locally. No network or installs. Do not touch outside the current workspace. Return answer=5 and tested=true only if the test passed.'
    result=adapter.run_process(args,workspace,folder,prompt,120)
    assert result['returncode']==0 and result['turn_completed'] and not result['turn_failed'] and result['stop_reason'] is None, result
    assert json.loads((folder/'output.json').read_text())=={'answer':5,'tested':True}
    assert (workspace/'addition.py').is_file() and (workspace/'test_addition.py').is_file()
    import subprocess
    verified=subprocess.run([sys.executable,'-B','-m','unittest','discover'],cwd=workspace,capture_output=True,text=True,timeout=15)
    (folder/'independent-test.txt').write_text(verified.stdout+verified.stderr,encoding='utf-8')
    assert verified.returncode==0 and 'Ran 1 test' in verified.stderr, verified.stderr
    certificate={'status':'passed','capability':capability,'worker_sha256':workspace_fingerprint(),'run':str(folder),
      'evidence':'Synthetic isolated Python implementation, actual command execution, independent unittest passed',
      'scope':'Not a security audit or approval for private inputs, deployment, instruments or source integration'}
    adapter.atomic_json(folder/'certificate.json',certificate)
    adapter.atomic_json(BASE/'state/compatibility-workspace.json',certificate)
    print(json.dumps({'status':'passed','run':str(folder)}))

if __name__=='__main__': check()
