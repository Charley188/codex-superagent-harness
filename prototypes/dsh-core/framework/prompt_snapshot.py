"""A request-bound prompt snapshot is evidence; permissions remain enforced by the host."""
import hashlib
import json
from pathlib import Path

DEFAULTS=json.loads((Path(__file__).parent/'prompts/defaults.json').read_text(encoding='utf-8'))['roles']

def text(request,role):
    snapshot=request.get('prompt')
    if snapshot is None:return DEFAULTS[role]
    if not isinstance(snapshot,dict) or set(snapshot)!={'role','revision','text','sha256'}:raise ValueError('Invalid prompt snapshot')
    # Saved configuration permits 1M UTF-16 characters; composed built-ins add a small fixed overhead.
    if snapshot['role']!=role or type(snapshot['revision'])is not int or snapshot['revision']<0 or not isinstance(snapshot['text'],str) or len(snapshot['text'])>1_100_000:raise ValueError('Invalid prompt identity or size')
    if hashlib.sha256(snapshot['text'].encode('utf-8')).hexdigest()!=snapshot['sha256']:raise ValueError('Prompt snapshot changed')
    return snapshot['text']
