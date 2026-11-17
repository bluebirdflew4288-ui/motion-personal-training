#!/usr/bin/env node
/* R02b 真实 ExerciseEditor DOM：逐轮阶段配置 3/2、独立修改、新增轮继承上一轮、失败保留。 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.MOTION_R02B_EVIDENCE_DIR || '/private/tmp/motion-harness-round-weight-20261115-v1/tests/r02b';
const req = createRequire(path.join(APP, 'package.json'));
const esbuild = req('esbuild');
const puppeteer = req('puppeteer-core');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const source = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ExerciseEditor } from './src/ui/ExerciseEditor';
const st=(id,label,w,min,max,fail,rest)=>({id,label,weightKg:w,repsMin:min,repsMax:max,toFailure:fail,targetText:'',...(rest===undefined?{}:{restAfterSec:rest})});
const initial={
  key:'r02b-initial', name:'变轮超级组', exerciseId:'custom:变轮超级组', restSec:90,
  target:{kind:'dropSet',form:'superset',rounds:2,
    stages:[st('a','阶段A',20,8,12,false,15),st('b','阶段B',15,8,12,false,20),st('c','阶段C',10,null,null,true)],
    roundConfigs:[{roundIndex:2,restInSec:25,stages:[st('a2','阶段A2',20,6,10,false,25),st('b2','阶段B2',15,10,15,true)]}],
    restInSec:15,restAfterSec:90,weightMode:'external'},
  arrangedGroups:[{index:1,stageCount:3},{index:2,stageCount:2}], memory:{mode:'none',revision:null},
};
let submitMode='ok';
createRoot(document.getElementById('root')).render(<ExerciseEditor open mode="edit" initial={initial} templates={[]} onClose={()=>{}} onSubmit={async(payload)=>{window.__lastPayload=structuredClone(payload);if(submitMode==='fail')return{ok:false,message:'注入失败'};return{ok:true};}} />);
window.__setSubmitMode=(m)=>{submitMode=m;};
window.__reset=()=>{window.__lastPayload=null;};
`;
const css=(await Promise.all(['tokens','base','zine'].map(n=>readFile(path.join(APP,'src/styles',`${n}.css`),'utf8')))).join('\n');
const built=await esbuild.build({stdin:{contents:source,resolveDir:APP,loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"',__MOTION_NATIVE__:'false',__MOTION_BUILD_TARGET__:'"web"'},logLevel:'silent'});
const server=createServer((q,r)=>{if(q.url==='/app.js'){r.setHeader('Content-Type','application/javascript');r.end(built.outputFiles[0].contents);}else if(q.url==='/style.css'){r.setHeader('Content-Type','text/css');r.end(css);}else{r.setHeader('Content-Type','text/html; charset=utf-8');r.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
await mkdir(OUT,{recursive:true});
const browser=await puppeteer.launch({executablePath:CHROME,headless:true,args:['--no-first-run','--disable-extensions','--no-sandbox']});
const page=await browser.newPage();
const result={suite:'r02b-round-editor',cases:[],errors:[]};
page.on('pageerror',e=>result.errors.push('pageerror: '+e.message));
page.on('console',m=>{if(m.type()==='error')result.errors.push('console: '+m.text());});
await page.setViewport({width:390,height:900});
const sel=(id)=>`[data-testid="${id}"]`;
const has=async(id)=>(await page.$(sel(id)))!==null;
const val=(id)=>page.$eval(sel(id),el=>el.value);
const fill=async(id,text)=>{await page.$eval(sel(id),el=>{el.focus();el.select();});await page.keyboard.type(text);};
const click=async(id)=>{await page.waitForSelector(sel(id),{timeout:3000});await page.click(sel(id));};
const save=()=>page.evaluate(()=>document.querySelector('[data-testid="editor-save"]').click());
const pause=(ms)=>new Promise(r=>setTimeout(r,ms));
const check=async(name,fn)=>{try{await fn();result.cases.push({name,ok:true});console.log('  ✔ '+name);}catch(e){result.cases.push({name,ok:false,detail:e instanceof Error?e.message:String(e)});console.log('  ✘ '+name+' :: '+(e instanceof Error?e.message:String(e)));}};
await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'load'});
await page.waitForSelector(sel('exercise-editor'));

await check('逐轮 tab 显示第 1 轮 3 阶段 / 第 2 轮 2 阶段；第 2 轮只渲染 2 行',async()=>{
  const t1=await page.$eval(sel('round-tab-1'),el=>el.textContent||''); const t2=await page.$eval(sel('round-tab-2'),el=>el.textContent||'');
  if(!t1.includes('3 阶段')||!t2.includes('2 阶段'))throw new Error('tab 阶段数错误: '+t1+' / '+t2);
  await click('round-tab-2');
  const rows=await page.$$eval('[data-testid^="stage-row-r2-"]',a=>a.length);
  if(rows!==2)throw new Error('第 2 轮行数应为 2，实际 '+rows);
  if((await val('stage-r2-0-reps-min'))!=='6')throw new Error('第 2 轮次数下限不是 6');
  if((await val('stage-r2-1-failure'))!==''){ /* checkbox uses checked, handled below */ }
  const checked=await page.$eval(sel('stage-r2-1-failure'),el=>el.checked); if(!checked)throw new Error('第 2 轮阶段2力竭应为开');
});

await check('编辑第 2 轮：保存 payload 只含第 2 轮覆盖，默认 3 阶段与第 1 轮原文不变',async()=>{
  await page.evaluate(()=>window.__reset());
  await fill('stage-r2-0-reps-min','7'); await fill('stage-r2-0-reps-max','9'); await fill('stage-r2-0-weight','22.5');
  await save(); await page.waitForFunction(()=>Boolean(window.__lastPayload),{timeout:2500});
  const t=await page.evaluate(()=>window.__lastPayload.target);
  if(t.stages.length!==3)throw new Error('默认阶段数被改: '+t.stages.length);
  if(t.stages[0].repsMin!==8)throw new Error('第 1 轮默认被改写');
  if(t.roundConfigs.length!==1||t.roundConfigs[0].roundIndex!==2)throw new Error('roundConfigs 异常');
  const r2=t.roundConfigs[0].stages;
  if(r2.length!==2||r2[0].repsMin!==7||r2[0].repsMax!==9||r2[0].weightKg!==22.5)throw new Error('第 2 轮独立值未保存');
});

await check('轮数 2→3：新增第 3 轮默认继承紧邻上一轮（2 阶段），不是全局默认 3 阶段',async()=>{
  await page.reload({waitUntil:'load'}); await page.waitForSelector(sel('exercise-editor'));
  await fill('editor-rounds','3');
  const t3=await page.$eval(sel('round-tab-3'),el=>el.textContent||'');
  if(!t3.includes('2 阶段'))throw new Error('新增轮未继承上一轮 2 阶段: '+t3);
});

await check('保存失败保留第 2 轮 raw；IME 组合中禁止提交',async()=>{
  await page.reload({waitUntil:'load'}); await page.waitForSelector(sel('exercise-editor'));
  await page.evaluate(()=>{window.__reset();window.__setSubmitMode('fail');});
  await click('round-tab-2'); await fill('stage-r2-0-weight','33');
  await save(); await page.waitForSelector(sel('editor-submit-error'),{timeout:2500});
  if((await val('stage-r2-0-weight'))!=='33')throw new Error('失败后 raw 丢失');
  await page.evaluate(()=>window.__setSubmitMode('ok'));
  await fill('stage-r2-0-label','组合阶段');
  await page.focus(sel('stage-r2-0-label'));
  await page.$eval(sel('stage-r2-0-label'),el=>{el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'组合中');el.dispatchEvent(new InputEvent('input',{bubbles:true,data:'组合中',isComposing:true}));});
  await page.evaluate(()=>window.__reset());
  await save(); await pause(120);
  if(await page.evaluate(()=>Boolean(window.__lastPayload)))throw new Error('IME 组合中被提交');
});

const failures=result.cases.filter(c=>!c.ok);
await writeFile(path.join(OUT,'results.json'),JSON.stringify(result,null,2));
await browser.close(); await new Promise(r=>server.close(r));
console.log(`R02B DOM: ${result.cases.length-failures.length}/${result.cases.length} passed; errors=${result.errors.length}`);
if(failures.length||result.errors.length)process.exitCode=1;
