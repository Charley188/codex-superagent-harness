import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const here=dirname(fileURLToPath(import.meta.url)),vendor=resolve(here,'../vendor/dsh/src/client')
const edits=[]
const replace=(text,from,to,file)=>{if(!text.includes(from))throw Error('Upstream changed: '+file);edits.push({file,from,to});return text.replace(from,to)}
await build({entryPoints:[resolve(here,'main.tsx')],outfile:resolve(here,'dist/panel.js'),bundle:true,format:'esm',target:'es2022',jsx:'automatic',minify:true,
  nodePaths:[resolve(here,'node_modules')],legalComments:'eof',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'codex-host-boundary',setup(b){
    b.onResolve({filter:/^clsx$/},()=>({path:resolve(here,'clsx.ts')}))
    b.onResolve({filter:/^\.\/(source|eval|execution)\.tsx$/},args=>args.importer===resolve(vendor,'settings.tsx')?{path:resolve(here,'settings.tsx')}:null)
    b.onResolve({filter:/\.css\?raw$/},args=>({path:resolve(args.resolveDir,args.path.slice(0,-4)),namespace:'raw-style'}))
    b.onLoad({filter:/.*/,namespace:'raw-style'},args=>({contents:readFileSync(args.path,'utf8'),loader:'text'}))
    b.onLoad({filter:/[\\/]client[\\/](api\.ts|ticket\.tsx|prompts\.tsx)$/},args=>{
      let text=readFileSync(args.path,'utf8')
      if(args.path.endsWith('api.ts')){
        text=replace(text,"const json = body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }", "const json = body === undefined && method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }",'api.ts')
        text=replace(text,'`/orchestrator/api/${path}`','`/orchestrator/api/${projectQuery(path)}`','api.ts')
        text=replace(text,"{ 'x-orchestrator-request': '1', ...json.headers }","{ 'x-orchestrator-request': '1', ...requestHeaders(), ...json.headers }",'api.ts')
        text=`import {requestHeaders,projectQuery} from ${JSON.stringify(resolve(here,'host-api.ts'))};\n`+text
      } else if(args.path.endsWith('ticket.tsx')) {
        // Inject only the Codex-specific review/job panel, leaving DSH detail rendering intact.
        text=replace(text,'<PageHead title={data.title}>', '<CodexTicket data={data} /><PageHead title={data.title}>','ticket.tsx')
        text=`import {CodexTicket} from ${JSON.stringify(resolve(here,'ticket-extra.tsx'))};\n`+text
      } else {
        text=replace(text,'<option value="worker">{valueLabel(t, \'promptRole\', \'worker\')}</option>', '<option value="worker">{valueLabel(t, \'promptRole\', \'worker\')}</option><option value="watchdog">{valueLabel(t, \'promptRole\', \'watchdog\')}</option>','prompts.tsx')
        text=replace(text,'return <>\n    <div className="dt-subhead">','return <>\n    <Hint>{preview.value.scope}</Hint><div className="dt-subhead">','prompts.tsx')
      }
      return {contents:text,loader:args.path.endsWith('.tsx')?'tsx':'ts',resolveDir:dirname(args.path)}
    })
  }}]})
mkdirSync(resolve(here,'dist'),{recursive:true})
writeFileSync(resolve(here,'dist/panel.css'),readFileSync(resolve(here,'dist/panel.css'),'utf8')+'\n'+readFileSync(resolve(here,'theme.css'),'utf8')+'\n'+readFileSync(resolve(here,'harness.css'),'utf8'))
writeFileSync(resolve(here,'adaptations.json'),JSON.stringify({baseline:'6337fc823ce20251c8de8085948165c81aaa701e',edits},null,2)+'\n')
console.log('DSH panel built; original vendor files unchanged.')
