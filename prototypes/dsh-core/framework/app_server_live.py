"""Synthetic real App Server generation and exact-thread resume acceptance."""
import json
from pathlib import Path
import sys
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from durable_worker import BASE, gate
import app_server

config, capability = gate()
folder = BASE / 'state/dsh-core/app-server-live' / str(uuid.uuid4())
schema = {'type': 'object', 'additionalProperties': False, 'properties': {'marker': {'type': 'string'}}, 'required': ['marker']}
first = folder / 'first'; first.mkdir(parents=True)
a = app_server.run(capability, first, first, 'Synthetic protocol test. Remember marker HARNESS_RESUME_83. Return {"marker":"HARNESS_RESUME_83"}. No tools.', schema, first/'output.json', None, 120)
assert a['returncode'] == 0, a
second = folder / 'second'; second.mkdir()
b = app_server.run(capability, second, second, 'Return the marker I asked you to remember in the previous turn. No tools.', schema, second/'output.json', a['session_id'], 120)
assert b['returncode'] == 0 and b['session_id'] == a['session_id'], b
assert json.loads((second/'output.json').read_text())['marker'] == 'HARNESS_RESUME_83'
report = {'status':'passed','same_session_resume':True,'structured_output':True,'transport':app_server.VERSION,'private_inputs_used':False,'directory':str(folder)}
(folder/'validation.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report))
