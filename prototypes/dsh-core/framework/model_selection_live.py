"""Synthetic real-model verification of selection changes on one persistent session."""
import json
import uuid
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from durable_worker import BASE,gate,load
from app_server import run
from model_catalog import catalog

def main():
    data=catalog();models=data['models'];default=data['defaults']
    alternative=next(m for m in models if m['model']!=default['model'])
    effort=next(e['reasoningEffort'] for e in alternative['supportedReasoningEfforts'] if e['reasoningEffort']!=default['effort'])
    speed=alternative['serviceTiers'][0]['id'] if alternative['serviceTiers'] else 'default'
    choices=[default,{'model':alternative['model'],'effort':effort,'serviceTier':speed},default]
    root=BASE/'state/model-selection-live'/str(uuid.uuid4());root.mkdir(parents=True)
    _,cap=gate();session=None
    schema={'type':'object','additionalProperties':False,'properties':{'reply':{'type':'string'}},'required':['reply']}
    for i,choice in enumerate(choices):
        folder=root/str(i);folder.mkdir()
        result=run(cap,folder,folder,'Synthetic configuration check: return READY in reply.',schema,folder/'output.json',session,180,model_selection=choice)
        assert result['returncode']==0,result
        if session:assert session==result['session_id']
        session=result['session_id']
        resolved=load(folder/'model-selection.json')['resolved']
        assert resolved['model']==choice['model'] and resolved['reasoningEffort']==choice['effort'],resolved
        assert (resolved['serviceTier'] or 'default')==choice['serviceTier'],resolved
    report={'status':'passed','same_session_model_switch':True,'restore_default':True,'directory':str(root),'private_inputs_used':False}
    (root/'validation.json').write_text(json.dumps(report),encoding='utf-8');print(json.dumps(report))
if __name__=='__main__':main()
