import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
await mkdir('tests/.generated',{recursive:true});
const result=await build({entryPoints:['tests/browser.ts'],bundle:true,platform:'browser',target:'es2020',write:false});
await writeFile('tests/.generated/browser.html',`<!doctype html><html><head><title>RUNNING</title></head><body>RUNNING<script>${result.outputFiles[0].text}</script></body></html>`);
