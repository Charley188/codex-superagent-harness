/** Decode an incomplete JSON string field without rendering the structured control envelope. */
export function previewField(source:string,field:string):string{
 const match=new RegExp('(?:^|[,{])\\s*"'+field+'"\\s*:\\s*"').exec(source)
 if(!match)return ''
 let encoded='',index=match.index+match[0].length
 for(;index<source.length;index++){
  const char=source[index]
  if(char==='"')break
  if(char==='\\'){
   const next=source[index+1];if(!next)break
   if(next==='u'){
    const digits=source.slice(index+2,index+6);if(!/^[a-f0-9]{4}$/i.test(digits))break
    encoded+=source.slice(index,index+6);index+=5
   }else{encoded+=char+next;index++}
  }else encoded+=char
 }
 try{return JSON.parse('"'+encoded+'"')}catch{return ''}
}
