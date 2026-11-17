#!/usr/bin/env node
/* G3A2 真实 App 删除/撤销接线检查：独立 browser context；真实鼠标左滑/点击。 */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';
import { g2bFix2Entry } from './dom-regression/g2b-fix2-entry.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.MOTION_G3A2_EVIDENCE_DIR || '/private/tmp/motion-editor-20261031/g3a2-resume-20261102/app';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(OUT, { recursive: true }); await mkdir(join(OUT, 'screens'), { recursive: true });
  const css = (await Promise.all(['tokens','base','zine'].map((n) => readFile(join(APP_DIR,'src/styles',`${n}.css`),'utf8')))).join('\n');
  const built = await esbuild.build({ stdin:{contents:g2bFix2Entry,resolveDir:APP_DIR,loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"',__AUDIT_STRICT__:'false',__MOTION_NATIVE__:'false',__MOTION_BUILD_TARGET__:'"web"'},nodePaths:[join(APP_DIR,'node_modules')],logLevel:'silent' });
  const js = built.outputFiles[0].contents;
  const server = createServer(async (req,res) => { res.setHeader('Cache-Control','no-store'); if(req.url.startsWith('/app.js')){res.setHeader('Content-Type','application/javascript');res.end(js);} else if(req.url.startsWith('/style.css')){res.setHeader('Content-Type','text/css');res.end(css);} else if(req.url.startsWith('/fonts/')){try{const f=join(APP_DIR,'public',req.url.split('?')[0]);res.setHeader('Content-Type','font/woff2');res.end(await readFile(f));}catch{res.statusCode=404;res.end();}} else res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>'); });
  await new Promise((r)=>server.listen(0,'127.0.0.1',r)); const url=`http://127.0.0.1:${server.address().port}`;
  const browser=await puppeteer.launch({executablePath:CHROME,headless:true,userDataDir:join(OUT,'chrome-profile'),args:['--no-first-run','--disable-extensions']});
  const result={suite:'g3a2-app-delete',cases:[],errors:[]}; let idx=0;
  const sel=(id)=>`[data-testid="${id}"]`;
  async function helpers(page){
    const hit=async(selector)=>{const el=await page.waitForSelector(selector,{visible:true,timeout:6000});await el.evaluate(e=>e.scrollIntoView({block:'center'}));await page.waitForFunction((s)=>{const e=document.querySelector(s);if(!e||e.disabled)return false;const r=e.getBoundingClientRect(),at=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return Boolean(at&&(e===at||e.contains(at)));},{timeout:5000},selector);await el.click();await sleep(40);};
    const clickText=async(text,scope)=>{const handles=await (scope?page.$$(scope+' button'):page.$$('button'));for(const h of handles.reverse()){if((await h.evaluate(e=>(e.textContent||'').trim()))===text){await h.evaluate(e=>e.scrollIntoView({block:'center'}));await page.waitForFunction(e=>{const r=e.getBoundingClientRect(),at=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !e.disabled&&at&&(e===at||e.contains(at));},{timeout:5000},h);await h.click();await sleep(50);return;}}throw Error('button missing '+text);};
    const swipe=async(testId)=>{const card=await page.waitForSelector(sel(testId),{visible:true,timeout:6000});await card.evaluate(e=>e.scrollIntoView({block:'center'}));const box=await card.boundingBox();if(!box)throw Error('no box '+testId);const x=box.x+box.width*.62,y=box.y+Math.min(22,box.height*.15);await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x-145,y,{steps:10});await page.mouse.up();const edit=sel(testId+'-delete');await page.waitForFunction((s)=>{const e=document.querySelector(s);if(!e)return false;const r=e.getBoundingClientRect(),at=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return at&&e.contains(at);},{timeout:5000},edit);await hit(edit);};
    const db=(sid='g2a-existing-session')=>page.evaluate(async(s)=>await window.__db.getSession(s),sid);
    /** 真实键盘：先命中焦点，再用 ArrowRight/Backspace 清空并逐键输入（不使用 value setter） */
    const typeReal=async(selector,value)=>{const el=await page.waitForSelector(selector,{visible:true,timeout:6000});await el.evaluate(e=>e.scrollIntoView({block:'center'}));await page.waitForFunction((s)=>{const e=document.querySelector(s);if(!e||e.disabled)return false;const r=e.getBoundingClientRect(),at=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return Boolean(at&&(e===at||e.contains(at)));},{timeout:5000},selector);await el.click();const n=(await el.evaluate(e=>e.value)).length+1;for(let i=0;i<n;i+=1)await page.keyboard.press('ArrowRight');for(let i=0;i<n;i+=1)await page.keyboard.press('Backspace');if((await el.evaluate(e=>e.value))!=='')throw Error('keyboard clear failed '+selector);await page.keyboard.type(String(value),{delay:8});if((await el.evaluate(e=>e.value))!==String(value))throw Error('keyboard type mismatch '+selector);};
    return {page,sel,hit,clickText,swipe,db,typeReal};
  }
  async function runCase(name,fn){idx+=1;const ctx=await browser.createBrowserContext();const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));const entry={name,ok:true,errors,screenshot:join(OUT,'screens',`case-${idx}.png`)};try{await page.setViewport({width:430,height:900,hasTouch:true,isMobile:true});await page.goto(url);await page.waitForFunction(()=>window.__booted===true||window.__bootError);if(await page.evaluate(()=>window.__bootError))throw Error(await page.evaluate(()=>window.__bootError));await page.waitForSelector(sel('exercise-card-g2b-multi'));await fn(await helpers(page));result.cases.push(entry);console.log('  ✔ '+name);}catch(e){entry.ok=false;entry.detail=e instanceof Error?e.message:String(e);result.cases.push(entry);console.log('  ✘ '+name+' :: '+entry.detail);}finally{try{await page.screenshot({path:entry.screenshot});}catch{}await ctx.close();}}
  await runCase('空白力量删除后 8秒 undo，其他动作后续 actual 保真', async(h)=>{const before=await h.db();await h.clickText('+ 临时加动作');await h.page.waitForSelector(h.sel('exercise-name-picker'));await h.typeReal(h.sel('name-custom-input'),'G3A2空白动作');await h.page.click(h.sel('name-custom-apply'));await h.page.waitForSelector(h.sel('exercise-editor'));await h.page.click(h.sel('editor-save'));await h.page.waitForFunction(()=>!document.querySelector('[data-testid="exercise-editor"]'));let s=await h.db();const added=s.exercises.find(e=>e.name==='G3A2空白动作');if(!added)throw Error('add failed');await h.swipe('exercise-card-'+added.id);await h.page.waitForSelector(h.sel('delete-undo-bar'));const afterDelete=await h.db();if(afterDelete.exercises.some(e=>e.id===added.id))throw Error('blank delete did not remove');await h.page.click(h.sel('delete-undo'));await h.page.waitForFunction(()=>window.__db.getSession('g2a-existing-session').then(s=>s.exercises.some(e=>e.name==='G3A2空白动作')));const afterUndo=await h.db();if(!afterUndo.exercises.some(e=>e.id===added.id))throw Error('undo failed');
    // 真实后续 actual：在另一个动作上真实键入 17，undo 后必须保真
    // 真实后续 actual：在 root-four（空白 4 轮递减）上真实键入，undo 后必须保真
    const expand = await h.page.$('[data-testid="exercise-card-root-four"] button[aria-expanded]');
    if (!expand) throw Error('root-four expand button missing');
    if ((await expand.evaluate((e) => e.getAttribute('aria-expanded'))) === 'false') await h.hit('[data-testid="exercise-card-root-four"] button[aria-expanded]');
    // 真实键盘在 root-four 第一个次数输入框键入 17（不猜 aria-label，取卡片内首个数字输入）
    const repsInput = await h.page.evaluateHandle(() => {
      const card = document.querySelector('[data-testid="exercise-card-root-four"]');
      return [...card.querySelectorAll('input')].find((e) => e.getAttribute('inputmode') === 'numeric' || e.type === 'number' || /次/.test(e.getAttribute('aria-label') || ''));
    });
    const el = repsInput.asElement();
    if (!el) throw Error('root-four reps input missing');
    await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await el.click();
    const n = (await el.evaluate((e) => e.value)).length + 1;
    for (let i = 0; i < n; i += 1) await h.page.keyboard.press('ArrowRight');
    for (let i = 0; i < n; i += 1) await h.page.keyboard.press('Backspace');
    await h.page.keyboard.type('17', { delay: 8 });
    await h.page.keyboard.press('Tab');
    await h.page.waitForFunction(() => window.__db.getSession('g2a-existing-session').then((s) => s.exercises.find((e) => e.id === 'root-four').sets.some((x) => x.reps === 17)), { timeout: 7000 });
    const final = await h.db();
    if (!final.exercises.some((e) => e.id === added.id)) throw Error('undo item lost after later input');
    if (!final.exercises.find((e) => e.id === 'root-four').sets.some((x) => x.reps === 17)) throw Error('later actual lost');
  });
  await runCase('有数据力量删除确认取消/确认', async(h)=>{const before=await h.db();const ex=before.exercises.find(e=>e.id==='g2b-multi');await h.swipe('exercise-card-g2b-multi');await h.page.waitForSelector(h.sel('confirm-ok'));await h.page.click(h.sel('confirm-cancel'));const cancel=await h.db();if(!cancel.exercises.some(e=>e.id===ex.id))throw Error('cancel removed data');await h.swipe('exercise-card-g2b-multi');await h.page.waitForSelector(h.sel('confirm-ok'));await h.page.click(h.sel('confirm-ok'));await h.page.waitForFunction(()=>window.__db.getSession('g2a-existing-session').then(s=>!s.exercises.some(e=>e.id==='g2b-multi')));const after=await h.db();if(after.exercises.some(e=>e.id===ex.id))throw Error('confirm did not delete');});
  await runCase('空白有氧删除 undo', async(h)=>{const before=await h.db();await h.clickText('+ 有氧爬坡');await h.page.waitForFunction(()=>window.__db.getSession('g2a-existing-session').then(s=>(s.cardio||[]).length>0));let s=await h.db();const c=s.cardio.find(e=>e.name.includes('有氧爬坡'));if(!c)throw Error('cardio add failed');await h.swipe('cardio-card-'+c.id);await h.page.waitForSelector(h.sel('delete-undo-bar'));await h.page.click(h.sel('delete-undo'));await h.page.waitForFunction((id)=>window.__db.getSession('g2a-existing-session').then(s=>(s.cardio||[]).some(e=>e.id===id)),{},c.id).catch(()=>{});const after=await h.db();if(!(after.cardio||[]).some(e=>e.id===c.id))throw Error('cardio undo failed');});
  await runCase('运行中有氧删除必须确认', async(h)=>{await h.clickText('+ 有氧爬坡');await h.page.waitForFunction(()=>window.__db.getSession('g2a-existing-session').then(s=>(s.cardio||[]).length>0));const s=await h.db();const c=s.cardio.find(e=>e.name.includes('有氧爬坡'));await h.clickText('开始','[data-testid="cardio-panel-'+c.id+'"]');await h.page.waitForFunction((id)=>window.__db.getSession('g2a-existing-session').then(s=>(s.cardio||[]).find(e=>e.id===id)?.status==='running'),{},c.id).catch(()=>{});await h.swipe('cardio-card-'+c.id);await h.page.waitForSelector(h.sel('confirm-ok'));await h.page.click(h.sel('confirm-ok'));await h.page.waitForFunction((id)=>window.__db.getSession('g2a-existing-session').then(s=>!(s.cardio||[]).some(e=>e.id===id)),{},c.id);});
  await writeFile(join(OUT,'results.json'),JSON.stringify(result,null,2));await browser.close();await new Promise(r=>server.close(r));const fails=result.cases.filter(c=>!c.ok);console.log(`G3A2 APP: ${result.cases.length-fails.length}/${result.cases.length}`);if(fails.length)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
