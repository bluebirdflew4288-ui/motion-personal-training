#!/usr/bin/env node
/* R02b 计划配置面板 DropSetEditor：逐轮 tab、独立阶段数、编辑第 2 轮不重写第 1 轮。 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const APP=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const OUT=process.env.MOTION_R02B_PLAN_EVIDENCE_DIR||'/private/tmp/motion-harness-round-weight-20261115-v1/tests/r02b-plan';
const req=createRequire(path.join(APP,'package.json')); const esbuild=req('esbuild'); const puppeteer=req('puppeteer-core');
const CHROME=process.env.MOTION_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const source=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {DropSetEditor} from './src/ui/DropSetEditor';import {dropTargetToDraft,draftToDropTarget,describeDropDraft} from './src/domain/dropSet';
const st=(id,w,min,max,fail,rest)=>({id,label:id,weightKg:w,repsMin:min,repsMax:max,toFailure:fail,targetText:'',...(rest===undefined?{}:{restAfterSec:rest})});
const target={kind:'dropSet',form:'superset',rounds:2,stages:[st('a',20,8,12,false,15),st('b',15,8,12,false,20),st('c',10,null,null,true)],roundConfigs:[{roundIndex:2,restInSec:25,stages:[st('a2',20,6,10,false,25),st('b2',15,10,15,true)]}],restInSec:15,restAfterSec:90,weightMode:'external'};
function Harness(){const [draft,setDraft]=useState(dropTargetToDraft(target));window.__draft=draft;window.__target=()=>draftToDropTarget(draft);window.__desc=describeDropDraft(draft);return <DropSetEditor draft={draft} onChange={setDraft} fieldPrefix="ex" />;}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
const css=(await Promise.all(['tokens','base','zine'].map(n=>readFile(path.join(APP,'src/styles',`${n}.css`),'utf8')))).join('\n');
const built=await esbuild.build({stdin:{contents:source,resolveDir:APP,loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"',__MOTION_NATIVE__:'false',__MOTION_BUILD_TARGET__:'"web"'},logLevel:'silent'});
const server=createServer((q,r)=>{if(q.url==='/app.js'){r.setHeader('Content-Type','application/javascript');r.end(built.outputFiles[0].contents);}else if(q.url==='/style.css'){r.setHeader('Content-Type','text/css');r.end(css);}else{r.setHeader('Content-Type','text/html; charset=utf-8');r.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r)); await mkdir(OUT,{recursive:true});
const browser=await puppeteer.launch({executablePath:CHROME,headless:true,args:['--no-first-run','--disable-extensions','--no-sandbox']});
const page=await browser.newPage(); const result={suite:'r02b-plan-editor',cases:[],errors:[]};page.on('pageerror',e=>result.errors.push(String(e)));
await page.setViewport({width:390,height:900}); await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'load'});
const sel=id=>`[data-testid="${id}"]`; const has=async id=>(await page.$(sel(id)))!==null; const fill=async(id,t)=>{await page.$eval(sel(id),el=>{el.focus();el.select();});await page.keyboard.type(t);}; const pause=ms=>new Promise(r=>setTimeout(r,ms));
const check=async(name,fn)=>{try{await fn();result.cases.push({name,ok:true});console.log('  ✔ '+name);}catch(e){result.cases.push({name,ok:false,detail:e instanceof Error?e.message:String(e)});console.log('  ✘ '+name+' :: '+(e instanceof Error?e.message:String(e)));}};
await check('逐轮 tab 显示 3/2 阶段；第 2 轮渲染 2 行',async()=>{
 const t1=await page.$eval(sel('drop-round-tab-1'),e=>e.textContent||''); const t2=await page.$eval(sel('drop-round-tab-2'),e=>e.textContent||'');
 if(!t1.includes('3 阶段')||!t2.includes('2 阶段'))throw new Error('tab 文案错: '+t1+'/'+t2);
 await page.click(sel('drop-round-tab-2')); await pause(80);
 const rows=await page.$$eval('[data-drop-round="2"]',a=>a.length); if(rows!==2)throw new Error('第2轮行数 '+rows);
});
await check('编辑第 2 轮后 draft.roundOverrides[2] 独立保存，第 1 轮默认与目标解析不变',async()=>{
 const inputs=await page.$$('[data-drop-round="2"] input.input');
 if(inputs.length<3)throw new Error('第2轮输入框数量 '+inputs.length);
 for(const [i,v] of [[0,'22'],[1,'7'],[2,'9']]){await inputs[i].evaluate(el=>{el.focus();el.select();});await page.keyboard.type(v);await page.keyboard.press('Tab');await pause(30);} await pause(100);
 const d=await page.evaluate(()=>window.__draft); const t=await page.evaluate(()=>window.__target());
 if(!d.roundOverrides||!d.roundOverrides.find(x=>x.roundIndex===2))throw new Error('draft 未生成第2轮 override');
 if(t.stages.length!==3||t.stages[0].repsMin!==8)throw new Error('第1轮默认被改');
 const r2=t.roundConfigs.find(x=>x.roundIndex===2); if(!r2||r2.stages[0].weightKg!==22||r2.stages[0].repsMin!==7)throw new Error('第2轮目标未保存: draft='+JSON.stringify(d.roundOverrides)+' target='+JSON.stringify(t.roundConfigs));
});
const failures=result.cases.filter(c=>!c.ok); await writeFile(path.join(OUT,'results.json'),JSON.stringify(result,null,2));
await browser.close(); await new Promise(r=>server.close(r)); console.log(`R02B PLAN: ${result.cases.length-failures.length}/${result.cases.length} passed; errors=${result.errors.length}`); if(failures.length||result.errors.length)process.exitCode=1;
