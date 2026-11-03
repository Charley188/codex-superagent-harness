import {require} from './contracts.mjs'
export const DEFAULT_WORKER_TIMEOUT_SECONDS=1200
export function executionSettings(store,capacity){
 const saved=store.get('codex.panel.settings.version:'+store.get('codex.panel.settings.revision'))
 return {maxWorkers:capacity,...saved?.value,workerTimeoutSeconds:saved?.value?.workerTimeoutSeconds??DEFAULT_WORKER_TIMEOUT_SECONDS}
}
export function validateWorkerTimeout(value){
 require(Number.isInteger(value)&&value>=60&&value<=7200,'Worker 执行时限必须为 60–7200 秒的整数')
 return value
}
