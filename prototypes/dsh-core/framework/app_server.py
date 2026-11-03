"""Versioned Codex App Server stdio transport, with owned process lifetime and durable events."""
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import time
from collections import deque

from research_ops import codex_adapter as adapter
from research_ops.processes import attach, close_job, stop

VERSION = 'codex-app-server-stdio-v1'
LIMIT = 32 * 1024 * 1024


class Rpc:
    def __init__(self, executable, cwd, folder, timeout=120, heartbeat=lambda: True, cancel=lambda: False):
        self.folder, self.started = Path(folder), time.monotonic()
        self.timeout, self.heartbeat, self.cancel = timeout, heartbeat, cancel
        self.reason, self.counter, self.session, self.turn = None, 0, None, None
        self.events, self.bytes = queue.Queue(), 0
        self.notifications = deque()
        self.folder.mkdir(parents=True, exist_ok=True)
        self.err = (self.folder / 'stderr.log').open('wb')
        self.log = (self.folder / 'app-server.jsonl').open('w', encoding='utf-8', buffering=1)
        self.ui_log = (self.folder / 'ui-events.jsonl').open('w', encoding='utf-8', buffering=1)
        args = [executable, '--no-daemon', '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use',
                '-c', 'web_search="disabled"', '-c', 'mcp_servers={}', 'app-server', '--listen', 'stdio://']
        options = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {'start_new_session': True}
        self.process = subprocess.Popen(args, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.err, **options)
        try:
            attach(self.process)
        except BaseException:
            self.log.close(); self.ui_log.close(); self.err.close()
            raise
        adapter.atomic_json(self.folder / 'process.json', {'pid': self.process.pid, 'started_unix': time.time(), 'command': args, 'transport': VERSION})

        def read():
            try:
                while True:
                    line = self.process.stdout.readline(LIMIT + 1)
                    if not line: break
                    self.events.put(line)
            finally:
                self.events.put(None)
        threading.Thread(target=read, daemon=True).start()

    def send(self, value):
        self.process.stdin.write((json.dumps(value, ensure_ascii=False) + '\n').encode('utf-8'))
        self.process.stdin.flush()

    def next(self, pending=True):
        if pending and self.notifications: return self.notifications.popleft()
        while True:
            if self.cancel(): self.reason = 'cancelled'
            elif not self.heartbeat(): self.reason = 'lease_lost'
            elif time.monotonic() - self.started > self.timeout: self.reason = 'timeout'
            if self.reason: raise RuntimeError(self.reason)
            if self.bytes + (self.folder / 'stderr.log').stat().st_size > LIMIT:
                self.reason = 'output_limit'; raise RuntimeError(self.reason)
            try: line = self.events.get(timeout=.1)
            except queue.Empty: continue
            if line is None: raise RuntimeError('App Server exited before a terminal response')
            self.bytes += len(line)
            if self.bytes > LIMIT or not line.endswith(b'\n'): raise ValueError('Oversized or incomplete App Server frame')
            value = json.loads(line)
            if not isinstance(value, dict): raise ValueError('Invalid App Server frame')
            self.log.write(json.dumps(value, ensure_ascii=False) + '\n')
            if 'method' in value:
                # Keep replay frames bounded and omit duplicated internal prompts from the UI stream.
                def bounded(item):
                    if isinstance(item, str): return item[:12000]
                    if isinstance(item, list): return [bounded(x) for x in item[:20]]
                    if isinstance(item, dict): return {k: bounded(v) for k, v in list(item.items())[:30]}
                    return item
                self.ui_log.write(json.dumps(bounded(value), ensure_ascii=False) + '\n')
            # Structured unattended roles do not grant new permissions or expose arbitrary client tools.
            if 'method' in value and 'id' in value:
                params=value.get('params', {})
                if self.session and params.get('threadId') not in (None,self.session): raise ValueError('Approval belongs to another thread')
                # DSH subagent-codex/wire.ts uses typed negative decisions for native requests.
                decisions={
                    'item/commandExecution/requestApproval': {'decision': 'decline'},
                    'item/fileChange/requestApproval': {'decision': 'decline'},
                    'item/permissions/requestApproval': {'permissions': {}, 'scope': 'turn'},
                    'item/tool/requestUserInput': {'answers': {}},
                    'mcpServer/elicitation/request': {'action': 'decline', 'content': None, '_meta': None},
                }
                if value['method'] in ('item/commandExecution/requestApproval','item/fileChange/requestApproval'):
                    available=params.get('availableDecisions')
                    if available is not None:
                        if not isinstance(available,list) or not any(v in available for v in ('cancel','decline')):raise ValueError('No unattended negative approval decision')
                        decisions[value['method']]={'decision':'cancel' if 'cancel' in available else 'decline'}
                if value['method'] in decisions:self.send({'id':value['id'],'result':decisions[value['method']]})
                else:self.send({'id': value['id'], 'error': {'code': -32601, 'message': 'Client actions are unavailable under this registered capability'}})
                continue
            return value

    def call(self, method, params):
        self.counter += 1
        identity = self.counter
        self.send({'id': identity, 'method': method, 'params': params})
        while True:
            value = self.next(pending=False)
            if value.get('id') != identity:
                if 'method' in value: self.notifications.append(value)
                continue
            if 'error' in value: raise RuntimeError(json.dumps(value['error'], ensure_ascii=False))
            return value.get('result', {})

    def initialize(self):
        result = self.call('initialize', {'clientInfo': {'name': 'codex_superagent', 'title': 'Codex Superagent', 'version': '1.0.0'}})
        self.send({'method': 'initialized', 'params': {}})
        return result

    def close(self):
        try:
            if self.process.poll() is None: stop(self.process)
        finally:
            close_job(self.process)
            self.process.stdout.close(); self.process.stdin.close()
            self.log.close(); self.ui_log.close(); self.err.close()


def run(capability, cwd, folder, prompt, schema, output, session, timeout, heartbeat=lambda: True, cancel=lambda: False, on_session=lambda s: None):
    rpc = Rpc(capability['executable'], cwd, folder, timeout, heartbeat, cancel)
    result = {'returncode': 1, 'session_id': None, 'turn_completed': False, 'turn_failed': False, 'event_error': None, 'stop_reason': None, 'transport': VERSION}
    messages = {}
    with (Path(folder) / 'events.jsonl').open('w', encoding='utf-8', buffering=1) as normalized:
        def event(value): normalized.write(json.dumps(value, ensure_ascii=False) + '\n')
        try:
            rpc.initialize()
            params = {'cwd': str(Path(cwd).resolve()), 'sandbox': 'read-only', 'approvalPolicy': 'never',
                      'config': {'web_search': 'disabled', 'mcp_servers': {}},
                      'developerInstructions': 'Use supplied input only. No tools, commands, external messages or file operations. Return the requested structured result.'}
            if session: params.update(threadId=session, excludeTurns=True)
            response = rpc.call('thread/resume' if session else 'thread/start', params)
            rpc.session = response['thread']['id']
            if session and rpc.session != session: raise ValueError('Resume changed thread identity')
            result['session_id'] = rpc.session
            on_session(rpc.session)
            event({'type': 'thread.started', 'thread_id': rpc.session})
            turn = rpc.call('turn/start', {'threadId': rpc.session, 'input': [{'type': 'text', 'text': prompt}],
                            'approvalPolicy': 'never', 'sandboxPolicy': {'type': 'readOnly', 'networkAccess': False}, 'outputSchema': schema})
            rpc.turn = turn['turn']['id']
            adapter.atomic_json(Path(folder) / 'app-server-turn.json', {'thread_id': rpc.session, 'turn_id': rpc.turn, 'transport': VERSION})
            while True:
                value = rpc.next()
                method, params = value.get('method'), value.get('params', {})
                if params.get('threadId') not in (None, rpc.session): continue
                incoming_turn=params.get('turnId')
                # Resuming can publish historical token-usage/activity frames. They are not this turn's result.
                if incoming_turn and incoming_turn!=rpc.turn: continue
                if method == 'item/completed' and params.get('item', {}).get('type') == 'agentMessage':
                    item = params['item']; phase=item.get('phase')
                    if phase not in (None,'commentary','partial_answer','final_answer'): raise ValueError('Unknown assistant message phase')
                    if phase!='commentary': messages[item['id']] = (phase,item.get('text', ''))
                    event({'type': 'item.completed', 'item': {'type': 'agent_message', 'id': item['id'], 'text': item.get('text', '')}})
                elif method == 'turn/completed' and params.get('turn', {}).get('id') == rpc.turn:
                    completed = params['turn']; result['turn_completed'] = completed.get('status') == 'completed'
                    result['turn_failed'] = not result['turn_completed']
                    if completed.get('error'): result['event_error'] = json.dumps(completed['error'], ensure_ascii=False)
                    event({'type': 'turn.completed' if result['turn_completed'] else 'turn.failed', 'turn': completed})
                    if result['turn_completed']:
                        # Use the final assistant message, never a commentary fragment or concatenated JSON objects.
                        candidates=list(messages.values())
                        text = next((text for phase,text in reversed(candidates) if phase=='final_answer'), None)
                        if text is None: text=next((text for phase,text in reversed(candidates) if phase=='partial_answer'), None)
                        if text is None: text=next((text for phase,text in reversed(candidates) if phase is None), '')
                        parsed = json.loads(text)
                        adapter.atomic_json(output, parsed)
                        result['returncode'] = 0
                    break
        except (ValueError, KeyError, TypeError, RuntimeError, OSError) as error:
            result['event_error'] = str(error)
            event({'type': 'error', 'message': str(error)})
        finally:
            result['stop_reason'] = rpc.reason
            # Ending this owned stdio process releases the writer; the durable thread remains resumable.
            rpc.close()
            adapter.atomic_json(Path(folder) / 'exit.json', result)
    return result
