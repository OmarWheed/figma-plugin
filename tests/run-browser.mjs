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
const profile=await mkdtemp(path.join(root,'test-profile-'));
try{
  const {stdout}=await promisify(execFile)(browser,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions',`--user-data-dir=${profile}`,'--dump-dom','--virtual-time-budget=20000',pathToFileURL(path.join(root,'browser.html')).href],{windowsHide:true,timeout:60000,maxBuffer:2000000});
  await writeFile(path.join(root,'browser-result.html'),stdout);
  if(!stdout.includes('<title>PASS</title>'))throw new Error(`Browser rendering tests failed: ${stdout.slice(0,2000)}`);
  console.log(`PASS: ${stdout.match(/"passed":(\d+)/)?.[1]} browser rendering/ZIP checks.`);
}finally{
  if(!profile.startsWith(root+path.sep))throw new Error('Refusing to remove a profile outside the generated test directory.');
  await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:250});
}
