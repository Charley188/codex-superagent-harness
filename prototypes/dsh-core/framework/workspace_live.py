"""Synthetic live acceptance: retrofit a persisted thread, re-read revisions, edit/test an isolated copy."""
import json
from pathlib import Path
import sys
import uuid
import zipfile
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from durable_worker import BASE,gate,load
import app_server
from workspace_access import config

def main():
    root=BASE/'state/dsh-core/workspace-live'/str(uuid.uuid4());root.mkdir(parents=True)
    source=root/'source';source.mkdir();work=root/'work';work.mkdir()
    schema={'type':'object','additionalProperties':False,'properties':{'reply':{'type':'string'}},'required':['reply']}
    _,cap=gate();session=None
    def call(name,prompt,tools=False,write=False):
        nonlocal session
        folder=root/name;folder.mkdir()
        policy=('Use only the project MCP tools to read CURRENT source documents. Do not use historical text as current evidence. '
                + ('You may use native file and command tools ONLY in the isolated current working directory to implement and test. Do not modify source or access the network. ' if write else 'Do not use native shell/file tools. ')
                +'Return JSON matching the schema.') if tools else None
        result=app_server.run(cap,work if write else folder,folder,prompt,schema,folder/'output.json',session,240,
            mcp_servers=config(source,folder/'workspace-access',work if write else None) if tools else None,
            workspace_write=write,developer_instructions=policy)
        assert result['turn_completed'] and result['returncode']==0,result
        if session:assert session==result['session_id']
        session=result['session_id'];print(json.dumps({'stage':name,'state':'passed'}),flush=True)
        return load(folder/'output.json')['reply']
    call('old-session','This is a synthetic migration test. Reply READY in the JSON reply field. No tools.')
    def revision(marker):
        with zipfile.ZipFile(source/'revision.docx','w') as z:
            z.writestr('word/document.xml','<w:document xmlns:w="urn:word"><w:p><w:t>'+marker+'</w:t></w:p></w:document>')
    first='LIVE_DOCX_'+uuid.uuid4().hex;revision(first)
    assert first in call('read-first','Use project_read to read revision.docx and return its exact contents.',True)
    second='REVISED_DOCX_'+uuid.uuid4().hex;revision(second)
    (source/'new-file.txt').write_text('NEW_FILE_VISIBLE',encoding='utf-8')
    reply=call('read-revision','The source revision.docx was changed and new-file.txt was added. Re-read both using project tools. Return their exact current contents.',True)
    assert second in reply and first not in reply and 'NEW_FILE_VISIBLE' in reply,reply
    (source/'addition.py').write_text('def add(a, b):\n    return a - b\n',encoding='utf-8')
    reply=call('edit-and-test','Use project_checkout for addition.py. In your isolated copy, correct add(a,b) to return a+b. Create test_addition.py using unittest with assertions 2+3=5 and -1+1=0. Actually execute python -B -m unittest -v. Report the real result; do not merely propose or claim tests.',True,True)
    assert (work/'addition.py').exists() and (work/'test_addition.py').exists(),reply
    assert 'a - b' in (source/'addition.py').read_text(), 'Original project was changed'
    import subprocess
    test=subprocess.run([sys.executable,'-B','-m','unittest','-v'],cwd=work,capture_output=True,text=True,timeout=30)
    assert test.returncode==0,test.stderr
    events=[json.loads(line) for line in (root/'edit-and-test/app-server.jsonl').read_text(encoding='utf-8').splitlines()]
    commands=[e['params']['item'] for e in events if e.get('method')=='item/completed' and e.get('params',{}).get('item',{}).get('type')=='commandExecution']
    assert any('unittest' in str(x) and x.get('exitCode')==0 for x in commands),'No actual native test execution receipt'
    reads=[json.loads(line) for line in (root/'read-revision/workspace-access/access.jsonl').read_text(encoding='utf-8').splitlines()]
    assert any(r.get('path')=='revision.docx' and r['operation']=='read' for r in reads)
    report={'status':'passed','directory':str(root),'existing_session_upgraded':True,'same_session_revision':True,
        'new_file_visible':True,'docx_live_reads':True,'native_edit_and_test':True,'original_unchanged':True,'version_receipts':True,'private_inputs_used':False}
    (root/'validation.json').write_text(json.dumps(report),encoding='utf-8');print(json.dumps(report),flush=True)

if __name__=='__main__':main()
