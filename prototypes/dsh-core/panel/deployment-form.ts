/** ConfigPageForm bridge; the original DSH DeploymentPage owns editing and drafts. */
import {useCallback} from 'react'
import {ApiError,usePoll} from '../vendor/dsh/src/client/api.ts'
import {request} from './host-api.ts'
export function useDeploymentForm(){
 const {data,reload}=usePoll(()=>request('/orchestrator/api/codex/deployment'),[],3000) as any
 const mutate=useCallback(async(ops:unknown[],revision:number)=>{
  try{await request('/orchestrator/api/codex/deployment',{ops,revision},'PUT');await reload();return true}
  catch(error){await reload();throw new ApiError(error.message,error.status??0)}
 },[reload])
 return {state:data??{status:'loading',writable:false},mutate}
}
