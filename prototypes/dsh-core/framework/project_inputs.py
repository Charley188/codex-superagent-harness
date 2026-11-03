"""Read a UI-registered project and prepare bounded text snapshots; never execute project files."""
import json, sys, sqlite3, zipfile, os
from pathlib import Path
from xml.etree import ElementTree as ET

def repository(config, host, repo_id):
    if not repo_id.startswith('workspace-project-'):
        return config['repositories'].get(repo_id)
    db=sqlite3.connect((host/'runtime/orchestrator.sqlite').as_uri()+'?mode=ro',uri=True)
    try:
        row=db.execute("SELECT value FROM kv WHERE key='sa.workspace.projects'").fetchone()
        projects=json.loads(row[0]) if row else []
    finally: db.close()
    project=next((p for p in projects if any(c['repo_id']==repo_id for c in p['capabilities'])),None)
    if not project: return None
    return {'root':str(host/'project-inputs'/project['id']),'allow_model_review':True}

def capture(root):
    root=Path(root).resolve(strict=True); files=[]; skipped=[]; total=0; scanned=0
    excluded={'.git','.codex','.agents','.aws','.ssh','node_modules','__pycache__','.venv','venv'}
    text={'.md','.txt','.py','.js','.ts','.tsx','.jsx','.json','.yaml','.yml','.toml','.v','.sv','.vhd','.tcl','.m','.c','.h','.cpp','.css','.html','.tex','.csv'}
    for folder,dirs,names in os.walk(root,followlinks=False):
        dirs[:]=sorted(d for d in dirs if d not in excluded and not d.startswith('.') and not (Path(folder)/d).is_symlink() and not (hasattr(Path(folder)/d,'is_junction') and (Path(folder)/d).is_junction()))
        for name in sorted(names):
            p=Path(folder)/name; rel=p.relative_to(root).as_posix(); scanned+=1
            if scanned>500: skipped.append('其余文件：已达到500项扫描上限'); return {'root':str(root),'files':files,'omitted':skipped,'complete':False}
            if name.startswith(('.', '~$')) or any(s in name.lower() for s in ('.env','credential','secret','private_key')): skipped.append(rel+':隐藏、临时或凭据名称'); continue
            if p.is_symlink() or not p.resolve().is_relative_to(root): skipped.append(rel+':链接'); continue
            if p.stat().st_size>20_000_000: skipped.append(rel+':文件过大'); continue
            content=None
            try:
                if p.suffix.lower() in text and p.stat().st_size<=200000: content=p.read_text(encoding='utf-8-sig')
                elif p.suffix.lower() in ('.docx','.pptx'):
                    with zipfile.ZipFile(p) as z:
                        parts=[i for i in z.infolist() if i.filename=='word/document.xml' or (i.filename.startswith('ppt/slides/slide') and i.filename.endswith('.xml'))]
                        if sum(i.file_size for i in parts)>2_000_000: raise ValueError('文档XML过大')
                        content='\n'.join(' '.join(e.text or '' for e in ET.fromstring(z.read(i)).iter() if e.tag.endswith('}t')) for i in parts)
                if content is None: skipped.append(rel+':暂不支持或文本过大'); continue
                if len(files)>=20 or total+len(content)>40000: skipped.append(rel+':超过本轮资料预算'); continue
                total+=len(content);files.append({'path':rel,'text':content})
            except (OSError,UnicodeError,ValueError,zipfile.BadZipFile,ET.ParseError) as e: skipped.append(rel+':'+str(e)[:120])
    return {'root':str(root),'files':files,'omitted':skipped,'complete':not skipped,'note':'Snapshot only; generated outputs stay in the isolated assignment workspace.'}

if __name__=='__main__':
    if sys.argv[1]!='capture': raise ValueError('Unknown operation')
    sys.stdout.reconfigure(encoding='utf-8'); print(json.dumps(capture(sys.argv[2]),ensure_ascii=False))
