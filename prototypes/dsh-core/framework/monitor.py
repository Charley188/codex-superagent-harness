"""Independent infrastructure monitor. It never restarts work or infers a tool's success."""
import argparse
import json
from pathlib import Path
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from durable_worker import BASE, adapter, require

def monitor(directory, stale=20):
    directory=directory.resolve(); require(directory.is_relative_to((BASE/'state/dsh-core').resolve()), 'Monitor outside owned runtime')
    previous=None
    while not (directory/'monitor.stop').exists():
        try:
            state=json.loads((directory/'monitor-input.json').read_text(encoding='utf-8'))
            age=time.time()-state['at']
            alerts=[]
            if age>stale: alerts.append({'kind':'host_unresponsive','age_seconds':round(age),'action':'execution leases expire; no auto-restart'})
            alerts += [{'kind':'uncertain','id':s['id']} for s in state.get('executions',[]) if s['state']=='uncertain']
            value={'healthy':not alerts,'alerts':alerts}
            adapter.atomic_json(directory/'monitor-status.json', {**value,'checked_at':time.time()})
            key=json.dumps(value,sort_keys=True)
            if key!=previous:
                with (directory/'monitor-events.jsonl').open('a',encoding='utf-8') as out: out.write(json.dumps({**value,'at':time.time()})+'\n')
                previous=key
            if age>stale+30: break
        except (OSError, json.JSONDecodeError): pass
        time.sleep(1)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--directory',type=Path,required=True); parser.add_argument('--stale',type=float,default=20)
    args=parser.parse_args(); monitor(args.directory,args.stale)
