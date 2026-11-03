"""Run one registered tool job in its owned output directory, with a process-tree lease."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from durable_worker import BASE, adapter, require, load
from research_ops.processes import attach, stop, close_job

def run(path):
    path = path.resolve(); folder = path.parent
    require(path.is_relative_to((BASE / 'state/dsh-core').resolve()), 'Job outside owned state')
    request = load(path)
    require(str(uuid.UUID(request['id'])) == folder.name, 'Job identity mismatch')
    profile = request['profile']; timeout = profile['timeout_seconds']
    require(isinstance(timeout, (int, float)) and 0 < timeout <= 86400, 'Invalid job timeout')
    require(profile['argv'] and all(isinstance(a, str) for a in profile['argv']), 'Registered argv required')
    heartbeat = lambda: (folder / 'heartbeat').exists() and time.time() - (folder / 'heartbeat').stat().st_mtime < 15
    require(heartbeat(), 'Job host lease expired')
    output = folder / 'output'; output.mkdir(exist_ok=True)
    argv = [a.replace('{output}', str(output)).replace('{workspace}', request.get('workspace', str(output))) for a in profile['argv']]
    with (folder / 'launched.json').open('x', encoding='utf-8') as f:
        json.dump({'pid': os.getpid(), 'at': time.time()}, f)
    options = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {'start_new_session': True}
    started = time.monotonic(); reason = None
    with (folder / 'stdout.log').open('wb') as out, (folder / 'stderr.log').open('wb') as err:
        process = subprocess.Popen(argv, cwd=output, stdin=subprocess.DEVNULL, stdout=out, stderr=err, **options)
        attach(process)
        adapter.atomic_json(folder / 'process.json', {'pid': process.pid, 'started_unix': time.time(), 'command': argv})
        try:
            while process.poll() is None:
                if (folder / 'cancel').exists(): reason = 'cancelled'
                elif not heartbeat(): reason = 'lease_lost'
                elif time.monotonic() - started > timeout: reason = 'timeout'
                elif sum(p.stat().st_size for p in (folder / 'stdout.log', folder / 'stderr.log')) > 32 * 1024 * 1024: reason = 'output_limit'
                if reason: stop(process)
                else: time.sleep(.1)
        except BaseException:
            stop(process); raise
        finally:
            close_job(process)
    artifacts = []
    status = 'cancelled' if reason == 'cancelled' else 'failed' if reason or process.returncode else 'completed'
    try:
        for name in profile.get('artifacts', []):
            p = (output / name).resolve()
            require(p.is_relative_to(output.resolve()) and p.is_file() and p.stat().st_size <= 64 * 1024 * 1024, 'Missing/unsafe artifact: ' + name)
            artifacts.append({'path': name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest(), 'bytes': p.stat().st_size})
    except ValueError as error:
        status = 'failed'; reason = str(error)
    adapter.atomic_json(folder / 'result.json', {'id': request['id'], 'request_hash': hashlib.sha256(path.read_bytes()).hexdigest(),
        'status': status, 'exit_code': process.returncode, 'reason': reason, 'artifacts': artifacts})

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--request', type=Path, required=True)
    run(parser.parse_args().request)
