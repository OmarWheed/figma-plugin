import {prepareExport} from './prepare-export';
const button=document.querySelector<HTMLButtonElement>('#export')!;
const status=document.querySelector<HTMLElement>('#status')!;
const summary=document.querySelector<HTMLElement>('#summary')!;
button.addEventListener('click',()=>{button.disabled=true;summary.textContent='';status.textContent='Scanning selected frames and preparing files…'; parent.postMessage({pluginMessage:{type:'start'}},'*');});
window.onmessage=async(event)=>{
 const msg=event.data.pluginMessage;
 if(!msg)return;
 if(msg.type==='progress'){status.textContent=msg.message;return;}
 if(msg.type==='error'){status.textContent=msg.message;button.disabled=false;return;}
 if(msg.type==='export'){
  try{
   const {zip,assets,duplicates,empty,notes}=await prepareExport(msg.files,message=>status.textContent=message);
   status.textContent='Creating ZIP…';
   const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE'});
   const url=URL.createObjectURL(blob);
   const a=document.createElement('a');a.href=url;a.download=msg.name;document.body.appendChild(a);a.click();a.remove();
   setTimeout(()=>URL.revokeObjectURL(url),10000);
   summary.textContent=`${msg.summary.screens} screens · ${assets.filter(a=>a.type==='image').length} unique images · ${assets.filter(a=>a.type==='svg').length} unique SVGs · ${duplicates} duplicates removed · ${empty} empty assets removed`;
   status.textContent=`ZIP download requested. ${notes.length} skipped items are explained in metadata/export_report.json.`;
  }catch(e){status.textContent=`ZIP error: ${String(e)}`;}
  button.disabled=false;
 }
};
