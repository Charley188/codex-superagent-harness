import {ApiError,usePoll} from '../vendor/dsh/src/client/api.ts'
import {useDraft,SaveBar} from '../vendor/dsh/src/client/draft.tsx'
import {Input} from '../vendor/dsh/src/client/controls.tsx'
import {Section,LoadState} from '../vendor/dsh/src/client/widgets.tsx'
import {Field,Fields} from '../vendor/dsh/src/client/settings-kit.tsx'
import {request} from './host-api.ts'
import {LIMITS} from '../vendor/dsh/src/limits.ts'
function RuntimeForm({data,reload}:{data:any,reload:()=>Promise<void>}){
  const draft=useDraft({key:'codex/runtime/'+data.directory,saved:data.settings.value,revision:data.settings.revision,reload,
    save:async(value,revision)=>{try{return await request('/orchestrator/api/codex/runtime',{value,revision},'PUT')}catch(e){throw new ApiError(e.message,e.status??0)}}})
  return <form className="dt-form" onSubmit={draft.submit}><Fields disabled={draft.busy}>
    <div className="dt-form dt-block"><h2 className="dt-block-title">执行器</h2>
      <Section title="执行模型"><Input value="跟随 Codex 本机配置" readOnly/><p className="dt-hint">按角色选择模型尚未接通；这里显示当前生效方式。</p></Section>
      <Field label="同时运行的 Worker 数量"><Input type="number" min={LIMITS.maxWorkers.min} max={LIMITS.maxWorkers.max} required value={draft.value.maxWorkers} onChange={e=>draft.edit({maxWorkers:e.target.value===''?null:Number(e.target.value)})}/></Field>
      <p className="dt-hint">支持 1–16 个 Worker 并行。保存后用于后续调度；减少数量会等待当前工作结束。实际并行数取决于可执行任务、依赖、资源占用和模型额度。</p>
    </div>
    <div className="dt-form dt-block"><h2 className="dt-block-title">执行环境</h2><Field label="交付工作区"><Input className="dt-mono" value={data.directory+'/workspaces'} readOnly/></Field>
      <p className="dt-hint">每项任务在独立交付目录执行。自定义准备命令、环境变量和命令黑名单尚未适配；目前只执行已登记作业。</p>
    </div>
    </Fields>
    <SaveBar {...draft} onDiscard={draft.discard}/>
    <Section title="保存历史">{data.history.length?data.history.map(h=><p key={h.revision}>版本 {h.revision} · {h.savedAt} · 并发 {h.value.maxWorkers}</p>):<p className="dt-hint">尚未修改，使用运行配置。</p>}</Section>
  </form>
}
export function ExecutionSettings(){const {data,error,reload}=usePoll(()=>request('/orchestrator/api/codex/runtime'),[],5000);return data?<RuntimeForm data={data} reload={reload}/>:<LoadState error={error} loading/>}
export function SourceSettings(){return <Section title="本地对话"><p>当前来源：本机用户消息、Worker 结果和登记工具结果。</p><p className="dt-hint">GitHub/飞书来源、账号绑定及连接器配置尚未适配。本组暂时只读。</p></Section>}
export function EvalSettings(){return <><Section title="策略"><p>当前只处理本机用户的明确请求，并受已登记项目能力和任务授权约束。</p><p className="dt-hint">DSH 的接单规则、允许名单、接纳模式和来源成员同步尚未接通，本组暂时只读。</p></Section><Section title="研判模型"><Input value="跟随 Codex 本机配置" readOnly/><p className="dt-hint">按角色选择模型尚未接通。</p></Section></>}
