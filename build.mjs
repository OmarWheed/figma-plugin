import { build, context } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
await mkdir('dist',{recursive:true});
const watch = process.argv.includes('--watch');
const codeOptions={entryPoints:['src/code.ts'],bundle:true,platform:'browser',target:'es2020',outfile:'dist/code.js'};
const uiOptions={entryPoints:['src/ui.ts'],bundle:true,platform:'browser',target:'es2020',write:false};
async function bundleUI(){
 const result=await build(uiOptions);
 const script=result.outputFiles[0].text;
 const template=await readFile('src/ui.html','utf8');
 await writeFile('dist/ui.html',template.replace('/* INSERT_BUNDLE */',script));
}
await bundleUI();
if(watch){const ctx=await context(codeOptions);await ctx.watch(); console.log('Watching code.ts. Re-run npm run build after changing ui.ts or ui.html.');}
else {await build(codeOptions); console.log('Built dist/code.js and dist/ui.html');}
