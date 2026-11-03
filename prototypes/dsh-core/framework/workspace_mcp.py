"""Local stdio MCP bridge for registered project access; no network listener."""
import argparse
import json
import sys
from workspace_access import WorkspaceAccess

def serve(access):
    for line in sys.stdin:
        request=json.loads(line)
        if 'id' not in request:continue
        identity=request['id'];method=request.get('method');params=request.get('params',{})
        try:
            if method=='initialize':result={'protocolVersion':params.get('protocolVersion','2024-11-05'),'capabilities':{'tools':{}},'serverInfo':{'name':'codex-project-workspace','version':'1.0.0'}}
            elif method=='ping':result={}
            elif method=='tools/list':result={'tools':access.tools()}
            elif method=='tools/call':
                try:
                    value=access.call(params['name'],params.get('arguments',{}))
                    result={'content':[{'type':'text','text':json.dumps(value,ensure_ascii=False)}],'isError':False}
                except (ValueError,TypeError,KeyError,OSError,UnicodeError) as e:
                    access.receipt('error',{'tool':params.get('name'),'error':str(e)})
                    result={'content':[{'type':'text','text':str(e)}],'isError':True}
            else:
                print(json.dumps({'jsonrpc':'2.0','id':identity,'error':{'code':-32601,'message':'Unsupported method'}}),flush=True);continue
            print(json.dumps({'jsonrpc':'2.0','id':identity,'result':result},ensure_ascii=False),flush=True)
        except Exception as e:
            print(json.dumps({'jsonrpc':'2.0','id':identity,'error':{'code':-32603,'message':str(e)}}),flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--audit',required=True);parser.add_argument('--workspace')
    args=parser.parse_args();sys.stdin.reconfigure(encoding='utf-8');sys.stdout.reconfigure(encoding='utf-8')
    serve(WorkspaceAccess(args.root,args.audit,args.workspace))
