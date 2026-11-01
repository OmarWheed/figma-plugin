import './build-browser.mjs';
import {existsSync} from 'node:fs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const browser=[process.env.CHROME_BINARY,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p=>p&&existsSync(p));
if(!browser)throw new Error('Set CHROME_BINARY to a Chromium browser executable to run rendering tests.');
const root=path.resolve('tests/.generated');
const decode=s=>s.replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
async function runPage(page,label){
  const profile=await mkdtemp(path.join(root,'test-profile-'));
  try{
    const {stdout}=await promisify(execFile)(browser,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions',`--user-data-dir=${profile}`,'--dump-dom','--virtual-time-budget=30000',pathToFileURL(path.join(root,page)).href],{windowsHide:true,timeout:90000,maxBuffer:8000000});
    await writeFile(path.join(root,page.replace('.html','-result.html')),stdout);
    if(!stdout.includes('<title>PASS</title>')){
      const result=stdout.match(/data-result="([^"]*)"/)?.[1];
      throw new Error(`${label} failed: ${result?decode(result):stdout.slice(0,2000)}`);
    }
    const passed=decode(stdout).match(/"passed":(\d+)/)?.[1];
    console.log(`PASS: ${passed} ${label} checks.`);
  }finally{
    if(!profile.startsWith(root+path.sep))throw new Error('Refusing to remove a profile outside the generated test directory.');
    await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:250});
  }
}
await runPage('browser.html','browser rendering/ZIP');
await runPage('ui.html','end-to-end UI');
