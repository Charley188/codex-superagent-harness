"""Live, project-scoped filesystem tools. Read receipts never replace future reads."""
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import time
import zipfile
from xml.etree import ElementTree as ET

EXCLUDED = {'.git', '.codex', '.agents', '.aws', '.ssh', 'node_modules', '__pycache__', '.venv', 'venv'}
MAX_FILE = 20_000_000

def registered_project(host, project_id=None, repo_id=None):
    if repo_id and not repo_id.startswith('workspace-project-'):return None
    if project_id and not project_id.startswith('project-'):return None
    if not project_id and not repo_id:return None
    db = sqlite3.connect((Path(host)/'runtime/orchestrator.sqlite').as_uri()+'?mode=ro', uri=True)
    try:
        row = db.execute("SELECT value FROM kv WHERE key='sa.workspace.projects'").fetchone()
        projects = json.loads(row[0]) if row else []
    finally:
        db.close()
    project = next((p for p in projects if (project_id and p['id']==project_id) or
                    (repo_id and any(c['repo_id']==repo_id for c in p['capabilities']))), None)
    if not project:
        return None
    root = Path(project['root'])
    if not root.is_dir() or root.resolve()!=root:
        raise ValueError('Registered project folder moved or became a link')
    return project

def excluded(name):
    return name in EXCLUDED or name.startswith(('.', '~$')) or any(x in name.lower() for x in ('.env','credential','secret','private_key'))

def text_content(path, raw):
    suffix = path.suffix.lower()
    if suffix in ('.docx', '.pptx', '.xlsx'):
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            parts = [i for i in z.infolist() if i.filename=='word/document.xml' or
                     i.filename.startswith(('word/header','word/footer','word/footnotes','word/endnotes','ppt/slides/slide','xl/sharedStrings','xl/worksheets/sheet')) and i.filename.endswith('.xml')]
            if sum(i.file_size for i in parts)>8_000_000:
                raise ValueError('Document XML exceeds extraction limit')
            return '\n'.join(' '.join(e.text or '' for e in ET.fromstring(z.read(i)).iter()
                                    if e.tag.endswith(('}t','}v'))) for i in parts)
    if suffix=='.pdf':
        try:
            from pypdf import PdfReader
        except ImportError:
            raise ValueError('PDF extraction requires pypdf; use a supported document or text source')
        return '\n'.join(p.extract_text() or '' for p in PdfReader(io.BytesIO(raw)).pages)
    if b'\x00' in raw[:8192]:
        raise ValueError('Binary file: text extraction is not supported for this format')
    return raw.decode('utf-8-sig')

class WorkspaceAccess:
    def __init__(self, root, audit, workspace=None):
        self.root = Path(root).resolve(strict=True)
        self.audit = Path(audit); self.audit.mkdir(parents=True, exist_ok=True)
        self.workspace = Path(workspace).resolve(strict=True) if workspace else None

    def path(self, name, allow_dir=False):
        if not isinstance(name,str) or len(name)>4096:
            raise ValueError('Invalid project path')
        path = Path(name)
        if not path.is_absolute():
            path = self.root/path
        # Check lexical path and every component as well as the final canonical path.
        rel = path.relative_to(self.root)
        if any(p=='..' or excluded(p) or ':' in p for p in rel.parts):
            raise ValueError('Path is outside the registered project or is excluded')
        current = self.root
        for part in rel.parts:
            current = current/part
            if current.is_symlink() or (hasattr(current,'is_junction') and current.is_junction()):
                raise ValueError('Project links are not followed')
        resolved = path.resolve(strict=True)
        if not resolved.is_relative_to(self.root) or not (resolved.is_file() or allow_dir and resolved.is_dir()):
            raise ValueError('Not an accessible project file/directory')
        return resolved

    def receipt(self, operation, value):
        with (self.audit/'access.jsonl').open('a', encoding='utf-8') as f:
            f.write(json.dumps({'at':time.time(),'operation':operation,**value},ensure_ascii=False)+'\n')

    def read_bytes(self, path):
        if path.stat().st_size>MAX_FILE:
            raise ValueError('File exceeds 20 MB per-read limit')
        with path.open('rb') as f:
            raw=f.read(MAX_FILE+1)
        if len(raw)>MAX_FILE:
            raise ValueError('File grew beyond read limit')
        digest=hashlib.sha256(raw).hexdigest()
        versions=self.audit/'versions'; versions.mkdir(exist_ok=True)
        dest=versions/digest
        if not dest.exists(): dest.write_bytes(raw)
        return raw,digest

    def list(self, path='.', offset=0):
        parent=self.path(path,True)
        if not parent.is_dir(): raise ValueError('Directory required')
        if type(offset) is not int or offset<0: raise ValueError('Invalid list offset')
        entries=[]
        for p in sorted(parent.iterdir(),key=lambda p:p.name.casefold()):
            if excluded(p.name) or p.is_symlink() or (hasattr(p,'is_junction') and p.is_junction()): continue
            entries.append({'path':p.relative_to(self.root).as_posix(),'kind':'directory' if p.is_dir() else 'file'})
        result={'root':str(self.root),'entries':entries[offset:offset+200],'next_offset':offset+200 if len(entries)>offset+200 else None}
        self.receipt('list',{'path':str(parent),'offset':offset,'count':len(result['entries'])})
        return result

    def read(self, path, offset=0, length=12000):
        if type(offset) is not int or offset<0 or type(length) is not int or not 1<=length<=30000:
            raise ValueError('Invalid read range')
        source=self.path(path);raw,digest=self.read_bytes(source);text=text_content(source,raw)
        result={'path':source.relative_to(self.root).as_posix(),'sha256':digest,'bytes':len(raw),
                'offset':offset,'text':text[offset:offset+length],'characters':len(text),
                'next_offset':offset+length if offset+length<len(text) else None,
                'note':'Read from the current project file at tool invocation; earlier receipts may refer to older versions.'}
        self.receipt('read',{k:v for k,v in result.items() if k not in ('text','note')})
        return result

    def search(self, query, path='.', offset=0):
        if not isinstance(query,str) or not 1<=len(query)<=200 or type(offset) is not int or offset<0:
            raise ValueError('Invalid search query/offset')
        base=self.path(path,True)
        if not base.is_dir(): raise ValueError('Directory required')
        scanned=0;matches=[];more=False
        for folder,dirs,names in os.walk(base,followlinks=False):
            dirs[:]=sorted(d for d in dirs if not excluded(d) and not (Path(folder)/d).is_symlink() and
                           not (hasattr(Path(folder)/d,'is_junction') and (Path(folder)/d).is_junction()))
            for name in sorted(names):
                if excluded(name):continue
                source=Path(folder)/name
                if source.is_symlink():continue
                scanned+=1
                if scanned<=offset:continue
                if scanned>offset+500:more=True;break
                rel=source.relative_to(self.root).as_posix()
                # Search names first; content is read explicitly to make its version auditable.
                if query.casefold() in rel.casefold():matches.append(rel)
            if more:break
        result={'matches':matches,'next_offset':offset+500 if more else None,'search':'file paths; use project_read for contents'}
        self.receipt('search',{'query':query,'path':path,**result});return result

    def checkout(self, path):
        if self.workspace is None: raise ValueError('This role cannot create or edit a work copy')
        source=self.path(path);raw,digest=self.read_bytes(source)
        relative=source.relative_to(self.root);target=self.workspace/relative
        current=self.workspace
        for part in relative.parts:
            current=current/part
            if current.is_symlink() or (hasattr(current,'is_junction') and current.is_junction()):
                raise ValueError('Work copy links are not followed')
        if not target.resolve().is_relative_to(self.workspace):raise ValueError('Work copy escaped workspace')
        if target.exists():
            return {'path':str(target),'copied':False,'reason':'Existing work copy preserved. Read the live source separately and merge deliberately; never overwrite local edits.'}
        target.parent.mkdir(parents=True,exist_ok=True)
        with target.open('xb') as f:f.write(raw)
        result={'source':str(source),'path':str(target),'sha256':digest,'copied':True}
        self.receipt('checkout',result);return result

    def tools(self):
        definitions=[('project_list','List a current project directory; page through next_offset. Paths are relative to the registered root or absolute within it.',{'path':{'type':'string'},'offset':{'type':'integer'}},['path']),
          ('project_search','Find current project files by path/name substring; paginate next_offset. Does not freeze the directory.',{'query':{'type':'string'},'path':{'type':'string'},'offset':{'type':'integer'}},['query']),
          ('project_read','Read the CURRENT file, including DOCX text. Returns file SHA256 and paginated text. Re-read after user revisions; old conversation text is not the current file.',{'path':{'type':'string'},'offset':{'type':'integer'},'length':{'type':'integer'}},['path'])]
        if self.workspace:
            definitions.append(('project_checkout','Copy one project file to this task isolated working directory, retaining existing edits. Use before editing/testing source files; never changes the original project.',{'path':{'type':'string'}},['path']))
        return [{'name':name,'description':desc,'annotations':{'readOnlyHint':name!='project_checkout','destructiveHint':False,'openWorldHint':False},'inputSchema':{'type':'object','properties':props,'required':required,'additionalProperties':False}} for name,desc,props,required in definitions]

    def call(self,name,args):
        handlers={'project_list':self.list,'project_search':self.search,'project_read':self.read,'project_checkout':self.checkout}
        if name not in {t['name'] for t in self.tools()} or not isinstance(args,dict): raise ValueError('Unknown tool or invalid arguments')
        return handlers[name](**args)

def config(root, audit, workspace=None):
    import sys
    args=['-B',str(Path(__file__).with_name('workspace_mcp.py')),'--root',str(root),'--audit',str(audit)]
    if workspace: args+=['--workspace',str(workspace)]
    # Registration authorizes these bounded local reads and non-overwriting task copies only.
    return {'workspace':{'command':sys.executable,'args':args,'startup_timeout_sec':20,'tool_timeout_sec':30,'required':True,'default_tools_approval_mode':'approve'},
            'codex_app':{'command':sys.executable,'enabled':False},
            'cua_repl':{'command':sys.executable,'enabled':False},'node_repl':{'command':sys.executable,'enabled':False}}
