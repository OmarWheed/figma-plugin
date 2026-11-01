import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
const result=await build({entryPoints:['src/code.ts'],bundle:true,write:false,platform:'browser',target:'es2020'});
const script=result.outputFiles[0].text;
const TEMP_NAME='Flutter Assets Exporter (temporary)';
let serial=0;
const registry=new Map();
function node(type,name,children=[],options={}){
  const width=options.width??24,height=options.height??24;
  const value={id:String(++serial),type,name,children,visible:true,opacity:1,fills:[],strokes:[],effects:[],exportSettings:[],layoutMode:'NONE',
    width,height,rotation:0,dashPattern:[],fillStyleId:'',strokeStyleId:'',
    absoluteRenderBounds:{x:0,y:0,width,height},absoluteBoundingBox:{x:options.x??0,y:options.y??0,width,height},relativeTransform:[[1,0,0],[0,1,0]],...options};
  if(!['FRAME','GROUP','COMPONENT','INSTANCE','BOOLEAN_OPERATION','SECTION'].includes(type))delete value.children;
  if(type==='TEXT'&&!value.getStyledTextSegments)value.getStyledTextSegments=()=>[];
  for(const child of children)child.parent=value;
  value.remove=()=>{value.removed=true;if(value.parent?.children)value.parent.children=value.parent.children.filter(n=>n!==value);};
  value.appendChild=child=>{if(child.parent?.children)child.parent.children=child.parent.children.filter(n=>n!==child);value.children.push(child);child.parent=value;};
  value.clone=()=>node(type,name,(value.children||[]).map(c=>c.clone()),options);
  registry.set(value.id,value);
  return value;
}
const solid=(r,g,b,extra={})=>({type:'SOLID',visible:true,color:{r,g,b},...extra});
const image=(name,options={})=>node('RECTANGLE',name,[],{fills:[{type:'IMAGE',visible:true,imageHash:'same'}],...options});
const text=(name,characters,options={})=>node('TEXT',name,[],{characters,getStyledTextSegments:()=>[{start:0,end:characters.length,fontName:{family:'Inter',style:'Regular'},fontSize:16,lineHeight:{unit:'AUTO'},fills:[solid(1,0,0)]}],...options});
const screen=(name,children,options={})=>node('FRAME',name,children,{width:375,height:812,...options});

async function sandbox(roots,{failMasked=false,leftovers=[],styles={},variables={},storage={}}={}){
  const calls=[],messages=[],temporary=[],listeners={},stored={...storage};
  const install=n=>{
    n.exportAsync=async settings=>{
      calls.push({name:n.name,format:settings.format,scale:settings.constraint?.value});
      if(failMasked&&n.name==='mask group')throw new Error('Injected mask failure');
      if(settings.format==='SVG_STRING')return `<svg width="24" height="24">${n.svgExtra??''}<path d="${n.name}"/></svg>`;
      return new Uint8Array([settings.constraint?.value??1,...Array.from(n.name,c=>c.charCodeAt(0))]);
    };
    if(n.children)n.children.forEach(install);
    return n;
  };
  roots.forEach(install);
  const page={type:'PAGE',name:'Page',children:[...leftovers],selection:roots};
  for(const n of [...leftovers,...roots])if(!n.parent)n.parent=page;
  const figma={
    mixed:Symbol('mixed'),showUI(){},currentPage:page,skipInvisibleInstanceChildren:false,
    ui:{postMessage:message=>messages.push(message),resize(w,h){figma.ui.size={w,h};}},
    on(event,callback){listeners[event]=callback;},
    clientStorage:{getAsync:async key=>stored[key],setAsync:async(key,value)=>{stored[key]=value;}},
    createFrame(){const frame=node('FRAME','temporary');temporary.push(frame);return frame;},
    group(children,parent){const group=install(node('GROUP','mask group',children));parent.children=[group];group.parent=parent;return group;},
    getStyleByIdAsync:async id=>styles[id]?{name:styles[id]}:null,
    variables:{getVariableByIdAsync:async id=>variables[id]?{name:variables[id]}:null},
    getNodeByIdAsync:async id=>registry.get(id)??null,
    setCurrentPageAsync:async()=>{},viewport:{scrollAndZoomIntoView(nodes){figma.viewport.zoomed=nodes;}},
    notify(message){figma.notified=message;}
  };
  vm.runInNewContext(script,{figma,__html__:'',console,Uint8Array,Map,Set,Date,Promise,setTimeout,clearTimeout});
  const send=message=>figma.ui.onmessage(message);
  return {figma,calls,messages,temporary,listeners,stored,send};
}
async function scan(roots,options={},settings={}){
  const box=await sandbox(roots,options);
  await box.send({type:'scan',settings});
  assert(!box.messages.find(m=>m.type==='error'),JSON.stringify(box.messages.filter(m=>m.type==='error')));
  const output=box.messages.find(m=>m.type==='scan-result');assert(output,'scan-result posted');
  return {...box,scan:output.scan};
}
let checks=0;
const check=(condition,message)=>{assert(condition,message);checks++;};

{ // Photo compositions stay whole; hidden layers and system bars are skipped; unnamed vector groups export as one SVG.
  const composition=node('GROUP','Photo collage',[image('left'),image('right'),node('RECTANGLE','overlay')]);
  const hidden=node('GROUP','hidden',[image('hidden image')],{visible:false});
  const status=node('INSTANCE','Status Bar',[node('VECTOR','battery')]);
  const icon=node('GROUP','unnamed vector artwork',[node('VECTOR','part1'),node('VECTOR','part2')]);
  const result=await scan([screen('screen',[composition,hidden,status,icon])]);
  assert.deepEqual(result.calls,[{name:'Photo collage',format:'PNG',scale:1},{name:'unnamed vector artwork',format:'SVG_STRING',scale:undefined}]);
  check(result.figma.skipInvisibleInstanceChildren===true,'Composition, hidden and system UI rules');
}
{ // Masks export with the siblings they clip; temporary copies are removed even when the export fails.
  const root=screen('screen',[node('ELLIPSE','mask',[],{isMask:true}),image('photo')]);
  const result=await scan([root]);
  assert.deepEqual(result.calls,[{name:'mask group',format:'PNG',scale:1}]);
  check(result.temporary.every(n=>n.removed)&&root.children.length===2,'Mask span exported, originals untouched');
  const failed=await scan([root],{failMasked:true});
  check(failed.temporary.every(n=>n.removed)&&failed.scan.skipped.some(n=>n.reason.includes('Injected mask failure')),'Temporary nodes removed after a failed export');
}
{ // A selected child inside a selected parent is scanned once.
  const child=node('FRAME','nested',[node('VECTOR','icon')]);
  const parent=node('FRAME','screen',[child]);
  const result=await scan([parent,child]);check(result.calls.length===1,'Overlapping selections scanned once');
}
{ // Identical output on two screens is one file with two occurrences.
  const result=await scan([screen('First',[node('VECTOR','same')]),screen('Second',[node('VECTOR','same')])]);
  check(result.scan.assets.length===1&&result.scan.assets[0].occurrences.length===2,'Exact duplicates share one file');
}
{ // Layers without render bounds are reported, not exported.
  const result=await scan([screen('screen',[node('VECTOR','zero',[],{absoluteRenderBounds:null}),node('VECTOR','ok')])]);
  check(result.calls.length===1&&result.calls[0].name==='ok'&&result.scan.skipped.some(n=>n.reason==='No visible render bounds'),'Empty render bounds skipped');
}
{ // Typography, fonts and colors are unique entries; ordinary app navigation is kept.
  const result=await scan([screen('screen',[text('label 1','Hello'),text('label 2','Hello'),node('GROUP','Navbar',[node('VECTOR','app tab')])])]);
  check(result.scan.fonts.length===1&&result.scan.typography.length===1&&result.scan.typography[0].uses===10&&result.scan.colors.length===1,'Unique tokens with character counts');
  check(result.calls.some(c=>c.name==='Navbar'),'App navigation retained');
}
{ // Plain rectangles/lines are skipped; arcs, dashed shapes and vectors are kept; the option can be turned off.
  const shapes=()=>[node('RECTANGLE','Rectangle 4',[],{fills:[solid(1,1,1)]}),node('LINE','Divider',[],{strokes:[solid(0,0,0)]}),
    node('ELLIPSE','Progress ring',[],{arcData:{startingAngle:0,endingAngle:Math.PI,innerRadius:0.8}}),node('RECTANGLE','Dashed',[],{strokes:[solid(0,0,0)],dashPattern:[4,4]}),node('VECTOR','star icon')];
  const on=await scan([screen('screen',shapes())]);
  check(on.calls.map(c=>c.name).join()==='Progress ring,Dashed,star icon','Plain shapes skipped by default');
  check(on.scan.skipped.filter(n=>n.reason.startsWith('Simple shape')).length===2,'Skipped shapes are explained');
  const off=await scan([screen('screen',shapes())],{},{skipShapes:false});
  check(off.calls.length===5,'Shape skipping can be turned off');
}
{ // SVG filters (shadow/blur) are not supported by flutter_svg: keep the look as PNG unless vectors are preferred.
  const shadowed=()=>node('VECTOR','card shadow icon',[],{svgExtra:'<filter id="f"><feGaussianBlur stdDeviation="2"/></filter>',effects:[{type:'DROP_SHADOW',visible:true}]});
  const png=await scan([screen('screen',[shadowed()])]);
  check(png.scan.assets[0].kind==='image'&&png.scan.assets[0].effects.includes('DROP_SHADOW')&&/PNG/.test(png.scan.assets[0].reason),'Effects exported as PNG by default');
  const vector=await scan([screen('screen',[shadowed()])],{},{effects:'svg'});
  check(vector.scan.assets[0].kind==='svg'&&/flutter_svg/.test(vector.scan.assets[0].reason),'Vector mode keeps SVG and explains the dropped effect');
}
{ // Figma export settings mark an asset boundary, even for an auto-layout card with text.
  const card=node('FRAME','Promo card',[text('title','Sale'),node('VECTOR','badge')],{layoutMode:'VERTICAL',exportSettings:[{format:'PNG'}],width:200,height:120});
  const result=await scan([screen('screen',[card])]);
  check(result.calls.length===1&&result.calls[0].name==='Promo card'&&result.calls[0].format==='PNG','Explicit export settings respected');
}
{ // A row of separate icons is split; an unnamed frame wrapping a multi-path icon stays whole.
  const tab=(name,x)=>node('INSTANCE',name,[node('VECTOR',`${name} path`)],{x,getMainComponentAsync:async()=>null});
  const row=node('FRAME','Frame 88',[tab('search',0),tab('bell',40),tab('menu',80)],{width:120,height:24});
  const wrapped=node('FRAME','Frame 12',[node('VECTOR','Vector'),node('VECTOR','Vector')],{width:24,height:24});
  const result=await scan([screen('screen',[row,wrapped])]);
  check(result.calls.map(c=>c.name).join()==='search,bell,menu,Frame 12','Separate icons split, wrapped icon kept whole');
}
{ // Generic layer names are replaced by component names or nearby labels.
  const set={type:'COMPONENT_SET',name:'Arrow'};
  const arrow=node('INSTANCE','Direction=Left, Size=24',[node('VECTOR','Vector')],{getMainComponentAsync:async()=>({name:'Direction=Left, Size=24',parent:set})});
  const tabItem=node('FRAME','Frame 5',[node('VECTOR','Vector',[],{x:0,y:0}),text('label','Home',{absoluteBoundingBox:{x:0,y:28,width:40,height:16}})],{layoutMode:'VERTICAL',width:60,height:48});
  const result=await scan([screen('Home screen',[arrow,tabItem])]);
  const names=result.scan.assets.map(a=>a.name);
  check(names.includes('Arrow Left 24'),'Component set and variant name used for an instance');
  check(names.includes('Home icon'),'Nearby text label used for a generic vector name');
}
{ // Variables and styles name the tokens; gradients are collected.
  const fill=solid(0.12,0.4,0.84,{boundVariables:{color:{id:'v1'}}});
  const gradient={type:'GRADIENT_LINEAR',visible:true,gradientTransform:[[0,1,0],[-1,0,1]],gradientStops:[{position:0,color:{r:1,g:0,b:0,a:1}},{position:1,color:{r:0,g:0,b:1,a:1}}]};
  const styled=node('RECTANGLE','Brand',[],{fills:[solid(1,1,1)],fillStyleId:'s1'});
  const result=await scan([screen('screen',[node('RECTANGLE','Button bg',[],{fills:[fill]}),node('RECTANGLE','Hero bg',[],{fills:[gradient]}),styled])],{variables:{v1:'brand/primary'},styles:{s1:'Surface/White'}});
  check(result.scan.colors.find(c=>c.r===31)?.names[0]==='brand/primary','Variable names attached to colors');
  check(result.scan.colors.find(c=>c.r===255)?.names[0]==='Surface/White','Paint style names attached to colors');
  check(result.scan.gradients.length===1&&result.scan.gradients[0].type==='linear'&&result.scan.gradients[0].stops.length===2,'Gradients collected');
}
{ // Directly selected artwork exports whole; a selected text layer exports as outlined SVG.
  const icon=node('GROUP','logo',[node('VECTOR','a'),node('VECTOR','b')]);
  const label=text('Wordmark','Acme');
  const result=await scan([icon,label]);
  check(result.calls.map(c=>c.name).join()==='logo,Wordmark','Selected artwork and text exported directly');
}
{ // @2x/@3x variants are exported on request, streamed back, and reported when done.
  const box=await scan([screen('screen',[image('hero',{width:100,height:50})])]);
  const key=box.scan.assets[0].key;
  await box.send({type:'variants',requestId:7,items:[{key,scales:[2,3]}]});
  const variants=box.messages.filter(m=>m.type==='variant');
  check(variants.length===2&&variants.every(v=>v.requestId===7&&v.bytes[0]===v.scale),'Variants exported at the requested scales');
  check(box.messages.some(m=>m.type==='variants-done'&&m.requestId===7&&m.failed.length===0),'Variant request completes');
}
{ // Cancel stops a scan before exporting.
  const box=await sandbox([screen('screen',[node('VECTOR','one'),node('VECTOR','two')])]);
  const running=box.send({type:'scan',settings:{}});
  await box.send({type:'cancel'});await running;
  check(box.messages.some(m=>m.type==='scan-cancelled')&&!box.messages.some(m=>m.type==='scan-result')&&box.calls.length===0,'Scan cancelled');
}
{ // Startup: leftover temporary frames are removed; settings and size are restored; locate selects layers.
  const leftover=node('FRAME',TEMP_NAME);
  const target=node('VECTOR','target');
  const box=await sandbox([screen('screen',[target])],{leftovers:[leftover],storage:{settings:{scales:[1,2],effects:'svg'},'ui-size':{width:700,height:800}}});
  check(leftover.removed===true,'Leftover temporary frame removed');
  await box.send({type:'ready'});
  const init=box.messages.find(m=>m.type==='init');
  check(init.settings.effects==='svg'&&init.settings.scales.join()==='1,2'&&box.figma.ui.size.w===700,'Settings and window size restored');
  await box.send({type:'select',ids:[target.id]});
  check(box.figma.currentPage.selection[0]===target&&box.figma.viewport.zoomed[0]===target,'Locate selects and zooms to the layer');
}
console.log(`PASS: ${checks} extraction checks (compositions, masks, duplicates, shapes, effects, export settings, naming, tokens, variants, cancel, startup).`);
