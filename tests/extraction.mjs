import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
const result=await build({entryPoints:['src/code.ts'],bundle:true,write:false,platform:'browser',target:'es2020'});
const script=result.outputFiles[0].text;
let serial=0;
function node(type,name,children=[],options={}){
  const value={id:String(++serial),type,name,children,visible:true,opacity:1,fills:[],strokes:[],exportSettings:[],layoutMode:'NONE',
    absoluteRenderBounds:{x:0,y:0,width:24,height:24},relativeTransform:[[1,0,0],[0,1,0]],...options};
  if(!['FRAME','GROUP','COMPONENT','INSTANCE','BOOLEAN_OPERATION'].includes(type))delete value.children;
  for(const child of children)child.parent=value;
  value.remove=()=>{value.removed=true;if(value.parent?.children)value.parent.children=value.parent.children.filter(n=>n!==value);};
  value.appendChild=child=>{if(child.parent?.children)child.parent.children=child.parent.children.filter(n=>n!==child);value.children.push(child);child.parent=value;};
  value.clone=()=>node(type,name,children.map(c=>c.clone()),options);
  return value;
}
const image=name=>node('RECTANGLE',name,[],{fills:[{type:'IMAGE',visible:true,imageHash:'same'}]});
async function run(roots,{failMasked=false}={}){
  const calls=[],messages=[],temporary=[];
  const install=n=>{
    n.exportAsync=async settings=>{
      calls.push({name:n.name,format:settings.format});
      if(failMasked&&n.name==='mask group')throw new Error('Injected mask failure');
      return settings.format==='SVG_STRING'?`<svg width="24" height="24"><path d="${n.name}"/></svg>`:new Uint8Array([1,...Array.from(n.name,c=>c.charCodeAt(0))]);
    };
    if(n.children)n.children.forEach(install);
    return n;
  };
  roots.forEach(install);
  const figma={showUI(){},currentPage:{selection:roots},ui:{postMessage:message=>messages.push(message)},
    createFrame(){const frame=node('FRAME','temporary');temporary.push(frame);return frame;},
    group(children,parent){const group=install(node('GROUP','mask group',children));parent.children=[group];group.parent=parent;return group;}
  };
  vm.runInNewContext(script,{figma,__html__:'',console,Uint8Array,Map,Set,Date});
  await figma.ui.onmessage({type:'start'});
  assert(!messages.find(m=>m.type==='error'),JSON.stringify(messages));
  const output=messages.find(m=>m.type==='export');assert(output);
  const json=path=>JSON.parse(Buffer.from(output.files.find(f=>f.path===path).bytes).toString());
  return {calls,temporary,output,json};
}
let checks=0;
{
  const composition=node('GROUP','Photo collage',[image('left'),image('right'),node('RECTANGLE','overlay')]);
  const hidden=node('GROUP','hidden',[image('hidden image')],{visible:false});
  const status=node('INSTANCE','Status Bar',[node('VECTOR','battery')]);
  const icon=node('GROUP','unnamed vector artwork',[node('VECTOR','part1'),node('VECTOR','part2')]);
  const result=await run([node('FRAME','screen',[composition,hidden,status,icon])]);
  assert.deepEqual(result.calls,[{name:'Photo collage',format:'PNG'},{name:'unnamed vector artwork',format:'SVG_STRING'}]);checks++;
}
{
  const root=node('FRAME','screen',[node('ELLIPSE','mask',[],{isMask:true}),image('photo')]);
  const result=await run([root]);
  assert.deepEqual(result.calls,[{name:'mask group',format:'PNG'}]);
  assert(result.temporary.every(n=>n.removed));assert.equal(root.children.length,2);checks++;
  const failed=await run([root],{failMasked:true});
  assert(failed.temporary.every(n=>n.removed));
  assert(failed.json('metadata/export_report.json').skipped.some(n=>n.reason.includes('Injected mask failure')));checks++;
}
{
  const child=node('FRAME','nested',[node('VECTOR','icon')]);
  const parent=node('FRAME','screen',[child]);
  const result=await run([parent,child]);assert.equal(result.calls.length,1);checks++;
}
{
  const a=node('VECTOR','same'),b=node('VECTOR','same');
  const result=await run([node('FRAME','First',[a]),node('FRAME','Second',[b])]);
  const assets=result.json('metadata/assets_manifest.json').assets;
  assert.equal(assets.length,1);assert.equal(assets[0].occurrences.length,2);checks++;
}
{
  const result=await run([node('FRAME','screen',[node('VECTOR','zero',[],{absoluteRenderBounds:null}),node('VECTOR','ok')])]);
  assert.equal(result.calls.length,1);assert.equal(result.calls[0].name,'ok');checks++;
}
{
  const text=name=>node('TEXT',name,[],{characters:'Hello',getStyledTextSegments:()=>[{start:0,end:5,fontName:{family:'Inter',style:'Regular'},fontSize:16,lineHeight:{unit:'AUTO'},fills:[{type:'SOLID',color:{r:1,g:0,b:0}}]}]});
  const result=await run([node('FRAME','screen',[text('label 1'),text('label 2'),node('GROUP','Navbar',[node('VECTOR','app tab')])])]);
  assert.equal(result.json('tokens/fonts.json').fonts.length,1);
  assert.equal(result.json('tokens/typography.json').typography[0].uses,10);
  assert.equal(result.json('tokens/colors.json').colors.length,1);
  assert(result.calls.some(c=>c.name==='Navbar'));checks++;
}
console.log(`PASS: ${checks} extraction cases (composition, masks, failure cleanup, overlapping selections, duplicates, empty bounds, unique tokens/app navigation).`);
