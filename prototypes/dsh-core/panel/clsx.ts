// Cordis-free replacement for the upstream components' conditional class-name helper.
export default function clsx(...values:any[]):string{return values.flat(Infinity).filter(Boolean).map(v=>typeof v==='object'?Object.keys(v).filter(k=>v[k]).join(' '):String(v)).join(' ')}
