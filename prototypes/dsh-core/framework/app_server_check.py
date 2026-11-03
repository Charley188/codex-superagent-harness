"""No-model protocol smoke against the installed executable; does not read user conversations."""
import json
from pathlib import Path
import sys
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from durable_worker import BASE, gate
from app_server import Rpc, VERSION

config, capability = gate()
folder = BASE / 'state/dsh-core/app-server-checks' / str(uuid.uuid4())
rpc = Rpc(capability['executable'], folder, folder, 30)
try:
    init = rpc.initialize()
    started = rpc.call('thread/start', {'cwd': str(folder), 'sandbox': 'read-only', 'approvalPolicy': 'never'})
    identity = started['thread']['id']
    read = rpc.call('thread/read', {'threadId': identity, 'includeTurns': False})
    assert read['thread']['id'] == identity
    print(json.dumps({'status': 'passed', 'transport': VERSION, 'version': capability['version'], 'metadata_read': True,
                      'model_called': False, 'directory': str(folder), 'initialize': init}, ensure_ascii=False))
finally:
    rpc.close()
