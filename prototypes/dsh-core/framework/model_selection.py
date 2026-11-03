"""Resolve only host-owned conversation selections; never edit desktop config."""
import json
import sqlite3
from pathlib import Path

def selection(host,project,target=''):
    if not project:return None
    key='sa.model:'+json.dumps([project,target],ensure_ascii=False,separators=(',',':'))
    db=sqlite3.connect((Path(host)/'runtime/orchestrator.sqlite').as_uri()+'?mode=ro',uri=True)
    try:
        row=db.execute('SELECT value FROM kv WHERE key=?',(key,)).fetchone()
        return json.loads(row[0])['value'] if row else None
    finally:db.close()

def worker_selection(host,ticket):
    db=sqlite3.connect((Path(host)/'runtime/orchestrator.sqlite').as_uri()+'?mode=ro',uri=True)
    try:row=db.execute('SELECT project FROM sa_ticket WHERE ticket_id=?',(ticket,)).fetchone()
    finally:db.close()
    return selection(host,row[0],ticket) if row else None
