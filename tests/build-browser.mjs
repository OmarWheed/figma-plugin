import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
await mkdir('tests/.generated',{recursive:true});
const bundle=async entry=>(await build({entryPoints:[entry],bundle:true,platform:'browser',target:'es2020',write:false})).outputFiles[0].text;
await writeFile('tests/.generated/browser.html',`<!doctype html><html><head><title>RUNNING</title></head><body>RUNNING<script>${await bundle('tests/browser.ts')}</script></body></html>`);
// The real UI page, with the fake sandbox loaded first in <head>.
const template=await readFile('src/ui.html','utf8');
const harness=await bundle('tests/ui-smoke.ts'),ui=await bundle('src/ui.ts');
await writeFile('tests/.generated/ui.html',template.replace('<head>',()=>`<head><script>${harness}</script>`).replace('/* INSERT_BUNDLE */',()=>ui));
