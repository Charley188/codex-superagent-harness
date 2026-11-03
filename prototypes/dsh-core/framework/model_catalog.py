"""Read installed Codex model capabilities without a model inference request."""
import json
import sys
import uuid
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from durable_worker import gate,BASE
from app_server import Rpc

def catalog():
    _,cap=gate();folder=BASE/'state/model-picker'/str(uuid.uuid4());folder.mkdir(parents=True)
    rpc=Rpc(cap['executable'],folder,folder,30)
    try:
        rpc.initialize();models=[];cursor=None
        while True:
            page=rpc.call('model/list',{'limit':100,'cursor':cursor});models.extend(page['data']);cursor=page.get('nextCursor')
            if not cursor:break
        response=rpc.call('thread/start',{'cwd':str(folder),'ephemeral':True,'sandbox':'read-only','approvalPolicy':'never'})
        return {'models':[m for m in models if not m.get('hidden')], 'defaults':{'model':response['model'],'effort':response['reasoningEffort'],'serviceTier':response.get('serviceTier') or 'default'}}
    finally:rpc.close()
if __name__=='__main__':print(json.dumps(catalog()))
