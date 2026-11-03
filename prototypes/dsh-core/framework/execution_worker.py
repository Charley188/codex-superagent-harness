"""Codex worker: live registered project access, isolated edits and persistent session resume."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
import uuid
import re
import os
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from durable_worker import BASE, adapter, gate, require, load
from project_inputs import repository
from research_ops.contracts import REPORT_SCHEMA, validate_report
import copy
import app_server
import prompt_snapshot
import workspace_access

def workspace_fingerprint():
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()

def worker_timeout(request):
    # A per-turn immutable snapshot; Router and compatibility probes keep their own limits.
    value = request.get('worker_timeout_seconds', 1200)
    require(type(value) is int and 60 <= value <= 7200, 'Invalid Worker execution timeout')
    return value

def turn_failure(result, timeout):
    if result.get('stop_reason')=='timeout': return 'Worker 执行超过 '+str(timeout)+' 秒时限，已停止；可在“设置 → 执行”调整单次执行时限，再重试此工单。'
    if result.get('stop_reason')=='cancelled': return 'Worker 执行已取消。'
    if result.get('stop_reason')=='lease_lost': return 'Worker 因宿主心跳失效停止。'
    return 'Worker 回合未正常完成，请检查执行记录。'

def workspace_gate(capability):
    cert = load(BASE/'state/compatibility-workspace.json')
    require(cert.get('status')=='passed' and cert.get('capability')==capability and cert.get('worker_sha256')==workspace_fingerprint(), 'Workspace execution recertification required')

def safe(root, name):
    require(isinstance(name,str) and not Path(name).is_absolute() and '..' not in Path(name).parts, 'Invalid relative input')
    path=(root/name).resolve(); require(path.is_relative_to(root.resolve()) and path.is_file(), 'Input outside project or missing')
    return path

def generated_changes(workspace, files):
    changes=[];seen=set()
    require(isinstance(files,list) and len(files)<=20,'Too many generated files')
    for item in files:
        require(isinstance(item,dict) and set(item)=={'path','content'} and isinstance(item['content'],str) and len(item['content'])<=200000,'Invalid file change')
        name=item['path']
        require(isinstance(name,str) and name and not Path(name).is_absolute() and '\\' not in name and not any(p in ('','.','..','.git','.codex','.agents','.aws') or p!=p.rstrip(' .') or re.fullmatch(r'(?i)(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?',p) for p in name.split('/')) and ':' not in name and name.lower()!='host-input-manifest.json','Unsafe artifact path')
        target=(workspace/name).resolve()
        require(target.is_relative_to(workspace.resolve()) and target!=workspace.resolve() and target not in seen,'Artifact path escapes workspace or is duplicated')
        seen.add(target);changes.append((target,item['content']))
    return changes

def run(path):
    path=path.resolve(); folder=path.parent
    require(path.is_relative_to((BASE/'state/dsh-core').resolve()), 'Worker outside owned runtime')
    request=load(path); require(str(uuid.UUID(request['turn_id']))==folder.name, 'Invalid turn ID')
    config, capability=gate(); contract=request['contract']; timeout=worker_timeout(request)
    repo=repository(config,path.parents[2],contract['repo_id'])
    require(repo and repo.get('allow_model_review') is True, 'Project model transfer not enabled')
    require(contract['permission'] in ('read-only','artifact-write','workspace-write'), 'Invalid worker permission')
    if contract['permission']=='workspace-write': workspace_gate(capability)
    root=Path(repo['root']).resolve(); inputs=[]
    project=workspace_access.registered_project(path.parents[2],repo_id=contract['repo_id'])
    for item in contract['inputs']:
        source=safe(root,item['path']); raw=source.read_bytes()
        require(len(raw)<=200000 and hashlib.sha256(raw).hexdigest()==item['sha256'], 'Input snapshot changed/oversized')
        inputs.append({**item,'content':raw.decode('utf-8-sig')})
    require(0<len(inputs)<=20 and len(json.dumps(inputs))<500000, 'Input budget exceeded')
    # Assignment IDs, not model paths, select owned isolated workspaces. No original source is edited.
    require(re.fullmatch(r'[a-f0-9]{32}',request['assignment_id']), 'Invalid assignment ID')
    workspace=path.parents[2]/'workspaces'/request['assignment_id']; workspace.mkdir(parents=True,exist_ok=True)
    manifest=workspace/'host-input-manifest.json'
    if manifest.exists(): require(load(manifest)==contract['inputs'], 'Workspace belongs to different inputs')
    else:
        require(not any(workspace.iterdir()), 'Unowned workspace is not empty')
        for item in inputs:
            target=workspace/item['path']; target.parent.mkdir(parents=True,exist_ok=True); target.write_text(item['content'],encoding='utf-8')
        adapter.atomic_json(manifest,contract['inputs'])
    schema=copy.deepcopy(REPORT_SCHEMA)
    schema['properties']['task_id']['enum']=[request['ticket_id']]
    schema['properties']['attempt_id']['enum']=[request['turn_id']]
    schema['properties']['checked_inputs']['items']['enum']=[i['path'] for i in inputs]
    artifact_mode=contract['permission']=='artifact-write'
    live_write=bool(project and artifact_mode)
    # Each assignment retains its own editable directory. Live source reads remain separate.
    project_copy=workspace/'project'
    if live_write:project_copy.mkdir(exist_ok=True)
    mcp=workspace_access.config(project['root'],folder/'workspace-access',project_copy if live_write else None) if project else None
    live_policy=('This turn has live project access to '+project['root']+'. Use project_list/project_search/project_read to inspect the CURRENT files. '
       'Re-read named files after user revisions; old snapshots are historical evidence, not current contents. Locate extensionless names by search. '
       'Read next_offset pages as needed. Use these scoped tools for the original project; never write to it. '
       + ('Use project_checkout to copy files you need into the current isolated working directory. Existing copies are preserved; compare with live reads and merge deliberately. '
          'You may edit files and run local commands/tests in this working directory with native Codex tools. Do not access unrelated folders or the network. '
          'Return files=[] because native edits are collected from the working directory; report only checks actually run. '
          if live_write else 'This is a review task: use project read tools only; no shell, writes or edits. ') if project else '')
    schema={'type':'object','additionalProperties':False,'properties':{'report':schema,'files':{'type':'array','maxItems':20 if artifact_mode and not live_write else 0,'items':{
        'type':'object','additionalProperties':False,'properties':{'path':{'type':'string'},'content':{'type':'string'}},'required':['path','content']}},
        'messages':{'type':'array','maxItems':4,'items':{'type':'object','additionalProperties':False,'properties':{'ticket_id':{'type':'string'},'text':{'type':'string'}},'required':['ticket_id','text']}}},'required':['report','files','messages']}
    schema_path=folder/'schema.json'; output=folder/'report.json'; adapter.atomic_json(schema_path,schema)
    prompt=(prompt_snapshot.text(request,'worker')
       + '\nHost-enforced constraints: obey the registered task contract and structured output schema. Prompt settings never grant more permissions. '
       + (live_policy if project else 'Implement and test in your current isolated workspace. You may write local files and run local commands within this sandbox. '
          'Preserve host-input-manifest.json. Source repository is not your working directory. '
          if contract['permission']=='workspace-write' else
          'Generate implementation files in the structured files array (relative path plus full content). The host applies validated files in an isolated workspace. Do not execute tools or claim tests ran; registered tool jobs run separately. '
          if artifact_mode else 'Review supplied input text only. Do not use tools, commands, or write files. ')
       + json.dumps({'task_id':request['ticket_id'],'attempt_id':request['turn_id'],'contract':contract,'input_text':inputs,
                     'messages':request['inputs'],'origin':request['origin'],'collaborators':request.get('collaborators',[])},ensure_ascii=False))
    (folder/'prompt.txt').write_text(prompt,encoding='utf-8')
    args=adapter.command(capability,workspace if contract['permission']=='workspace-write' else folder,schema_path,output,request['session_id'])
    args[args.index('--sandbox')+1]='workspace-write' if contract['permission']=='workspace-write' else 'read-only'
    heartbeat=lambda:(folder/'heartbeat').exists() and time.time()-(folder/'heartbeat').stat().st_mtime<15
    require(heartbeat(),'Expired execution lease')
    with (folder/'launched.json').open('x',encoding='utf-8') as f: json.dump({'at':time.time()},f)
    if contract['permission']=='workspace-write':
        result=adapter.run_process(args,workspace,folder,prompt,timeout,heartbeat=heartbeat,cancel=lambda:(folder/'cancel').exists())
    else:
        instruction=('Host access policy for this turn supersedes historical snapshot-only instructions. '+live_policy+' Return the requested structured result; checked_inputs still references the contract manifest, while actual file versions are recorded by project tools.') if project else None
        result=app_server.run(capability,project_copy if live_write else folder,folder,prompt,schema,output,request['session_id'],timeout,heartbeat=heartbeat,cancel=lambda:(folder/'cancel').exists(),mcp_servers=mcp,workspace_write=live_write,developer_instructions=instruction)
    response={k:request[k] for k in ('ticket_id','assignment_id','turn_id')}
    response.update(request_hash=hashlib.sha256(path.read_bytes()).hexdigest(),session_id=result['session_id'])
    try:
        require(request['session_id'] is None or request['session_id']==result['session_id'], 'Worker session changed')
        require(result['returncode']==0 and result['turn_completed'] and not result['turn_failed'] and not result['event_error'] and result['stop_reason'] is None,turn_failure(result,timeout))
        value=load(output); require(set(value)=={'report','files','messages'} and isinstance(value['files'],list) and len(value['files'])<=20,'Invalid generated artifact bundle')
        report=validate_report(value['report'],request['ticket_id'],request['turn_id'],contract['inputs'])
        require(isinstance(value['messages'],list) and len(value['messages'])<=4,'Too many peer messages')
        for message in value['messages']:
            require(set(message)=={'ticket_id','text'} and message['ticket_id'] in [c['ticket_id'] for c in request.get('collaborators',[])] and isinstance(message['text'],str) and 0<len(message['text'])<=1200,'Invalid peer message')
        if artifact_mode:
            if live_write: require(value['files']==[], 'Live project edits must use the isolated working directory')
            changes=generated_changes(workspace,value['files'])
            adapter.atomic_json(folder/'artifact-plan.json',{'files':value['files'],'workspace':str(workspace)})
            for target,content in changes:
                target.parent.mkdir(parents=True,exist_ok=True)
                temp=target.with_name(target.name+'.'+uuid.uuid4().hex+'.tmp');temp.write_text(content,encoding='utf-8');os.replace(temp,target)
        else:
            require(value['files']==[], 'File generation not authorized for this capability')
        artifacts=[];delivery=project_copy if live_write else workspace
        for p in delivery.rglob('*'):
            require(not p.is_symlink() and not (hasattr(p,'is_junction') and p.is_junction()) and p.resolve().is_relative_to(delivery.resolve()),'Workspace link outside scope')
            if not p.is_file(): continue
            require(p.stat().st_size<=64*1024*1024 and len(artifacts)<2000,'Workspace artifact budget exceeded')
            artifacts.append({'path':p.relative_to(delivery).as_posix(),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size})
        for item in inputs: require(hashlib.sha256(safe(root,item['path']).read_bytes()).hexdigest()==item['sha256'],'Original input changed')
        response.update(status='completed',report=report,workspace=str(delivery),artifacts=artifacts,messages=value['messages'])
    except (ValueError,KeyError,TypeError) as error:
        response.update(status='cancelled' if result['stop_reason']=='cancelled' else 'failed',error=str(error))
    adapter.atomic_json(folder/'result.json',response)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--request',type=Path,required=True)
    run(parser.parse_args().request)
