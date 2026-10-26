import {canonicalSvg,renderPixels,prepareExport,dartConstants} from '../src/prepare-export';
const checks:string[]=[];
function assert(condition:unknown,message:string){if(!condition)throw new Error(message);checks.push(message);}
const encode=(s:string)=>new TextEncoder().encode(s);
const svg=(body:string)=>`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${body}</svg>`;
async function run(){
  const first=svg('<defs><clipPath id="clip_A"><rect width="24" height="24"/></clipPath></defs><path clip-path="url(#clip_A)" d="M2 2H20V20H2Z" fill="red"/>');
  const second=first.replaceAll('clip_A','clip_B');
  assert(canonicalSvg(first)===canonicalSvg(second),'Generated SVG IDs do not create duplicates');
  assert(canonicalSvg(first)!==canonicalSvg(first.replace('red','blue')),'Different SVG colors remain distinct');
  assert(!(await renderPixels(encode(svg('<path d=""/>')),'svg')).painted,'Empty path is rejected');
  assert(!(await renderPixels(encode(svg('<g opacity="0"><rect width="24" height="24"/></g>')),'svg')).painted,'Invisible SVG geometry is rejected');
  assert((await renderPixels(encode(svg('<path d="M2 2L20 20" stroke="black" stroke-width="0.25"/>')),'svg')).painted,'Thin visible strokes are kept');
  let rejected=false;try{canonicalSvg(svg('<image href="data:image/png;base64,AA=="/>'));}catch{rejected=true;}
  assert(rejected,'Raster content is not accepted as vector SVG');
  const canvas=document.createElement('canvas');canvas.width=canvas.height=24;
  const context=canvas.getContext('2d')!;context.fillStyle='red';context.fillRect(0,0,24,24);
  const blob=await new Promise<Blob>(resolve=>canvas.toBlob(b=>resolve(b!),'image/png'));
  const png=new Uint8Array(await blob.arrayBuffer());
  const variant=new Uint8Array(png.length+3);variant.set(png);variant.set([1,2,3],png.length);
  const entries=[
    {id:'icon_1',path:'assets/icons/one.svg',type:'svg',bytes:encode(first),screenNodeId:'screen1',uses:2},
    {id:'icon1',path:'assets/icons/two.svg',type:'svg',bytes:encode(second),screenNodeId:'screen2',uses:3},
    {id:'blank',path:'assets/icons/blank.svg',type:'svg',bytes:encode(svg('<rect width="24" height="24" fill="none"/>')),screenNodeId:'screen1',uses:1},
    {id:'photo',path:'assets/images/photo.png',type:'image',bytes:png,screenNodeId:'screen1',uses:1},
    {id:'photo_copy',path:'assets/images/copy.png',type:'image',bytes:variant,screenNodeId:'screen2',uses:1}
  ];
  const assets=entries.map((a,i)=>({...a,bytes:undefined,name:a.id,screen:a.screenNodeId,figmaNodeId:`node${i}`,usage:a.id,
    occurrences:Array.from({length:a.uses},(_,index)=>({figmaNodeId:`node${i}_${index}`,screen:a.screenNodeId,screenNodeId:a.screenNodeId}))}));
  const files=[...entries.map(a=>({path:a.path,bytes:a.bytes})),
    {path:'metadata/assets_manifest.json',bytes:encode(JSON.stringify({version:1,screens:[{name:'First',figmaNodeId:'screen1'},{name:'Second',figmaNodeId:'screen2'}],assets}))},
    {path:'metadata/export_report.json',bytes:encode('{"skipped":[]}')},
    {path:'tokens/colors.json',bytes:encode('{"colors":[]}')}
  ];
  const result=await prepareExport(files,()=>{});
  assert(result.assets.length===2,'Only one SVG and one decoded PNG are retained');
  assert(result.empty===1,'Transparent SVG is excluded from the archive');
  assert(result.duplicates===5,'Duplicate count includes prior copies without double counting');
  assert(result.assets.find(a=>a.type==='svg')?.uses===5,'All SVG occurrences survive deduplication');
  const mapping=JSON.parse(await result.zip.file('metadata/screen_mapping.json')!.async('string'));
  assert(mapping.screens[1].assets[0].figmaNodeIds[0]==='node1_0','Screen mapping uses the correct source node after merging');
  assert(!result.zip.file('assets/icons/blank.svg')&&!result.zip.file('assets/images/copy.png'),'ZIP omits empty and duplicate asset files');
  const dart=dartConstants([{id:'icon_1',path:'a'},{id:'icon1',path:'b'},{id:'class',path:'c'},{id:'123',path:'d'}] as any);
  const names=Array.from(dart.matchAll(/static const String (\w+)/g),m=>m[1]);
  assert(new Set(names).size===4&&names.every(n=>/^[a-zA-Z]/.test(n)&&n!=='class'),'Dart identifiers are valid and unique');
  await result.zip.generateAsync({type:'uint8array'});
  document.body.textContent=JSON.stringify({passed:checks.length,checks});
  document.title='PASS';
}
run().catch(error=>{document.title='FAIL';document.body.textContent=JSON.stringify({error:String(error),checks});});
