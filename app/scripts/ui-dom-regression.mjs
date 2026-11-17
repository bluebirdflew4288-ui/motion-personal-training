#!/usr/bin/env node
/**
 * MOTION · 真实 DOM 关键缺陷回归测试套件
 *
 * 覆盖：
 *   1. draft: DraftCell Esc 数值恢复、非法 raw 清理、新输入提交、连续 Esc
 *   2. history-delete: dirty 纠错后删除成功退出、无死锁/隐形守卫、删除失败保留与重试
 *   3. history-missing: 外部删除后展示找不到记录、彻底消除隐形守卫
 *   4. history-intent-contract: BlockedNavigation 携带并消耗 replace / fallback / delta
 *   5. history-clean-ownership: 草稿复原安全离页、跨记录 A->B 隔离与所有权保护
 *   6. history-legal-raw: 聚焦合法 raw 在直接保存与 Tab 离页时的提交与校验
 *   7. history-forward: dirty 状态下 Forward 拦截恢复与确认后方向保真
 *   8. history-dirty: 完整 dirty 离页守卫、弹层留页/放弃/保存、事务互斥、非法 raw 禁用保存
 *   9. rest-web: Web 计时器启动、reload 恢复、暂停、加减时、继续、停止与快照生命周期
 *  10. rest-native: 延迟原生查询、用户即时操作保护、精确 token/generation 撤销
 *
 * 环境变量：
 *   MOTION_CHROME_PATH       Chrome 执行文件路径
 *   MOTION_UI_EVIDENCE_DIR   证据产物保存目录
 *   MOTION_AUDIT_REACT_MODE  React 环境模式（默认 production）
 *   MOTION_AUDIT_STRICT      是否启用 React 19 StrictMode（1 启用）
 *
 * 用法：
 *   node scripts/ui-dom-regression.mjs           # 执行全量 10 个套件
 *   node scripts/ui-dom-regression.mjs draft     # 单独执行某个套件
 */

import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';
import { draftEntry, historyEntry, restEntry, nativeBoundary } from './dom-regression/entries.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CHROME = process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : '/usr/bin/google-chrome';
const CHROME = process.env.MOTION_CHROME_PATH || DEFAULT_CHROME;

const ALL_SUITES = [
  'draft',
  'history-delete',
  'history-missing',
  'history-intent-contract',
  'history-clean-ownership',
  'history-legal-raw',
  'history-forward',
  'history-dirty',
  'rest-web',
  'rest-native',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSingleSuite(suiteName, baseEvidenceDir) {
  const suiteOutDir = join(baseEvidenceDir, suiteName);
  await mkdir(suiteOutDir, { recursive: true });
  const chromeProfileDir = join(suiteOutDir, 'chrome-profile');
  await mkdir(chromeProfileDir, { recursive: true });

  const entry =
    suiteName === 'draft'
      ? draftEntry
      : suiteName.startsWith('history')
        ? historyEntry
        : restEntry;

  const plugins =
    suiteName === 'rest-native'
      ? [
          {
            name: 'audit-native-io-boundary',
            setup(b) {
              b.onResolve({ filter: /^\.\.\/lib\/restReminder$/ }, () => ({
                path: 'native',
                namespace: 'audit',
              }));
              b.onLoad({ filter: /.*/, namespace: 'audit' }, () => ({
                contents: nativeBoundary,
                loader: 'js',
              }));
            },
          },
        ]
      : [];

  const reactMode = process.env.MOTION_AUDIT_REACT_MODE || 'production';
  const strictMode = process.env.MOTION_AUDIT_STRICT === '1';

  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: APP_DIR, loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: {
      'process.env.NODE_ENV': JSON.stringify(reactMode),
      __AUDIT_STRICT__: strictMode ? 'true' : 'false',
      __MOTION_NATIVE__: 'false',
      __MOTION_BUILD_TARGET__: JSON.stringify('web'),
    },
    plugins,
  });

  const js = built.outputFiles[0].contents;
  await writeFile(join(suiteOutDir, 'harness.js'), js);

  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url.startsWith('/app.js')) {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(js);
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>');
    }
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  let browser;
  const result = {
    suite: suiteName,
    reactMode,
    strict: strictMode,
    cases: [],
    errors: [],
    dialogs: [],
  };

  const check = (name, ok, evidence) => {
    result.cases.push({ name, ok: !!ok, evidence });
    if (!ok) {
      console.log(`  ✘ ${name}`);
    } else {
      console.log(`  ✔ ${name}`);
    }
  };

  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      userDataDir: chromeProfileDir,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', (e) => result.errors.push(String(e)));
    page.on('dialog', async (d) => {
      result.dialogs.push({ type: d.type(), message: d.message(), accepted: false });
      await d.dismiss();
    });

    const state = () => page.$eval('#state', (e) => JSON.parse(e.textContent));
    const go = async (suffix) => {
      let target = baseUrl + (suffix || '');
      if (suiteName.startsWith('rest-') && strictMode) {
        target += (target.includes('?') ? '&' : '?') + 'strict=1';
      }
      await page.goto(target);
      await page.waitForSelector('#state');
      await sleep(25);
    };

    const clickText = async (text) => {
      await page.evaluate((t) => {
        const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === t);
        if (!el) throw new Error(`Missing button ${t}`);
        el.click();
      }, text);
      await sleep(60);
    };

    const typeCell = async (text) => {
      await page.click('input');
      await page.$eval('input', (e) => e.select());
      if (text === '') await page.keyboard.press('Backspace');
      else await page.keyboard.type(text);
    };

    if (suiteName === 'draft') {
      for (const raw of ['25', '-', '.', '']) {
        await go();
        await typeCell(raw);
        await page.keyboard.press('Escape');
        await sleep(30);
        const s = await state();
        const input = await page.$eval('input', (e) => e.value);
        const alerts = await page.$$eval('[role=alert]', (els) => els.map((e) => e.textContent));
        check(
          `Escape restores model/display/validity for ${JSON.stringify(raw)}`,
          s.value === 10 && s.valid && s.commits.length === 0 && input === '10' && alerts.length === 0,
          { s, input, alerts },
        );
      }

      await go();
      await typeCell('25');
      await page.keyboard.press('Escape');
      await typeCell('30');
      await page.keyboard.press('Tab');
      await sleep(30);
      let s = await state();
      check('new valid edit commits after Escape', s.value === 30 && s.valid && JSON.stringify(s.commits) === '[30]', s);

      await typeCell('35');
      await page.keyboard.press('Enter');
      await sleep(30);
      s = await state();
      check('Enter commits after cancel and blur', s.value === 35 && s.valid && JSON.stringify(s.commits) === '[30,35]', s);

      for (const raw of ['-', '90', '.']) {
        await typeCell(raw);
        await page.keyboard.press('Escape');
        await sleep(15);
      }
      s = await state();
      check(
        'consecutive Escape never commits or leaves error',
        s.value === 35 &&
          s.valid &&
          JSON.stringify(s.commits) === '[30,35]' &&
          (await page.$eval('input', (e) => e.value)) === '35',
        s,
      );
    } else if (suiteName === 'rest-web') {
      await go();
      await page.waitForFunction(() => window.api && !window.api.active);
      await page.evaluate(() => window.api.start(60));
      await page.waitForFunction(() => window.api.active && window.api.endsAt !== null);

      const initial = await state();
      const snapshot = await page.evaluate(() =>
        JSON.parse(sessionStorage.getItem('motion-rest-timer:audit-rest-session')),
      );
      check('Web start writes genuine running snapshot', snapshot?.endsAt === initial.endsAt && snapshot?.generation === null, {
        initial,
        snapshot,
      });

      await page.reload();
      await page.waitForFunction(() => window.api?.active && window.api.endsAt !== null);
      let s = await state();
      check('Web reload retains deadline', s.endsAt === initial.endsAt, { initial, restored: s });

      await page.evaluate(() => window.api.pause());
      await sleep(30);
      s = await state();
      check('Web restored pause works', s.endsAt === null && s.pausedRemaining > 55000 && s.pausedRemaining <= 60000, s);

      const paused = s.pausedRemaining;
      await page.evaluate(() => window.api.adjust(15));
      await sleep(25);
      s = await state();
      check('paused +15 works', s.pausedRemaining === paused + 15000, s);

      await page.evaluate(() => window.api.adjust(-15));
      await sleep(25);
      s = await state();
      check('paused -15 works', s.pausedRemaining === paused, s);

      await page.reload();
      await page.waitForFunction(() => window.api?.pausedRemaining !== null);
      s = await state();
      check('paused reload retains remainder', s.pausedRemaining === paused && s.endsAt === null, s);

      await page.evaluate(() => window.api.resume());
      await sleep(25);
      s = await state();
      check(
        'restored resume works',
        s.endsAt !== null && s.pausedRemaining === null && Math.abs(s.endsAt - Date.now() - paused) < 2000,
        s,
      );

      await page.evaluate(() => window.api.start(30, { sessionExerciseId: 'ex-rest', setId: 'set-rest' }));
      await page.waitForFunction(() => window.api?.active && window.api.source?.sessionExerciseId === 'ex-rest');
      let sourceSnap = await page.evaluate(() => JSON.parse(sessionStorage.getItem('motion-rest-timer:audit-rest-session')));
      check('G3A1 start carries source metadata', sourceSnap?.source?.sessionExerciseId === 'ex-rest' && sourceSnap?.source?.setId === 'set-rest', sourceSnap);
      await page.reload();
      await page.waitForFunction(() => window.api?.active && window.api.source?.sessionExerciseId === 'ex-rest');
      s = await state();
      check('G3A1 reload retains source metadata', s.source?.sessionExerciseId === 'ex-rest', s);
      await page.evaluate(() => window.api.stop());
      await sleep(25);
      s = await state();
      check('G3A1 stop clears source', s.source == null && (await page.evaluate(() => sessionStorage.getItem('motion-rest-timer:audit-rest-session'))) === null, s);
      // 恢复原测试链最后一步的 stop 断言
      await page.evaluate(() => window.api.start(60));
      await sleep(20);
      s = await state();
      const deadline = s.endsAt;
      await page.evaluate(() => window.api.adjust(15));
      await sleep(25);
      s = await state();
      check('running +15 works', s.endsAt === deadline + 15000, s);

      await page.evaluate(() => window.api.adjust(-15));
      await sleep(25);
      s = await state();
      check('running -15 works', s.endsAt === deadline, s);

      await page.evaluate(() => window.api.stop());
      await sleep(25);
      s = await state();
      check(
        'stop clears timer and snapshot',
        !s.active && (await page.evaluate(() => sessionStorage.getItem('motion-rest-timer:audit-rest-session'))) === null,
        s,
      );
    } else if (suiteName === 'rest-native') {
      for (const action of ['pause', 'plus', 'minus', 'stop']) {
        await go('/?seed=1');
        await page.waitForFunction(() => window.api?.active && window.nativeResolvers.length > 0);
        const before = await state();
        await page.evaluate(
          (a) => (a === 'pause' ? window.api.pause() : a === 'stop' ? window.api.stop() : window.api.adjust(a === 'plus' ? 15 : -15)),
          action,
        );
        await sleep(30);
        const pending = await state();
        const expected =
          action === 'pause'
            ? pending.endsAt === null && pending.pausedRemaining > 0
            : action === 'stop'
              ? !pending.active
              : pending.endsAt === before.endsAt + (action === 'plus' ? 15000 : -15000);
        check(`pending native verify ${action} applies immediately`, expected, { before, pending });

        await page.evaluate(() =>
          window.nativeResolvers
            .splice(0)
            .forEach((r) => r({ available: true, active: true, token: 'audit-rest', generation: 4, fired: false, lastIntentId: 1 })),
        );
        await sleep(80);
        const after = await state();
        const trace = await page.evaluate(() => window.nativeTrace);
        check(
          `late native query preserves ${action}`,
          action === 'pause'
            ? after.endsAt === null && after.pausedRemaining === pending.pausedRemaining
            : action === 'stop'
              ? !after.active
              : after.endsAt === pending.endsAt,
          { pending, after, trace },
        );
        if (action === 'pause' || action === 'stop') {
          check(
            `late verified cancellation targets restored identity ${action}`,
            trace.cancels.some((c) => c?.token === 'audit-rest' && c?.generation === 4),
            trace,
          );
        }
      }

      for (const query of ['unavailable', 'reject']) {
        await go(`/?seed=1&query=${query}`);
        await page.waitForFunction(() => window.api?.active);
        await page.evaluate(() => window.api.pause());
        await sleep(30);
        const s = await state();
        check(`native ${query} still permits pause`, s.endsAt === null && s.pausedRemaining > 0, s);
      }

      await go('/?seed=1&known=1');
      await page.waitForFunction(() => window.api?.active);
      await page.evaluate(() => window.api.pause());
      await sleep(40);
      let s = await state();
      const trace = await page.evaluate(() => window.nativeTrace);
      check(
        'known native generation pause still cancels exact identity',
        s.endsAt === null && s.pausedRemaining > 0 && trace.cancels.some((c) => c.token === 'audit-rest' && c.generation === 4),
        { s, trace },
      );
    } else if (suiteName === 'history-missing') {
      const enter = async () => {
        await page.goto(baseUrl);
        await page.waitForFunction(() => window.auditReady && window.auditRefreshSessions);
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '纠正数据'));
        await clickText('纠正数据');
        await page.waitForSelector('textarea');
        await page.$eval('textarea', (e) => e.select());
        await page.type('textarea', 'dirty note before external delete');
        await page.$eval('textarea', (e) => e.blur());
        await page.click('input');
        await page.$eval('input', (e) => e.select());
        await page.type('input', '-');
        await page.keyboard.press('Tab');
        await sleep(25);
      };

      for (const action of ['return-history', 'tab-stats', 'native-back']) {
        await enter();
        const other = await browser.newPage();
        other.on('pageerror', (e) => result.errors.push(`external-page ${String(e)}`));
        await other.goto(`${baseUrl}/?reuse=1`);
        await other.waitForFunction(() => window.auditReady);
        await other.evaluate(() => window.audit.deleteSession(window.audit.id));
        await other.close();

        await page.evaluate(() => window.auditRefreshSessions());
        await page.waitForFunction(() => document.body.innerText.includes('找不到这条记录'));

        const before = await page.evaluate(async () => ({
          hash: location.hash,
          recordExists: !!(await window.audit.getSession(window.audit.id)),
          otherExists: !!(await window.audit.getSession(window.audit.otherId)),
        }));
        check(
          `external deletion updates missing view without touching other record ${action}`,
          !before.recordExists && before.otherExists,
          before,
        );

        if (action === 'return-history') await clickText('返回历史');
        else if (action === 'tab-stats') await page.click('a[href="#/stats"]');
        else await page.evaluate(() => window.audit.handleBackIntent({ handleLayer: false }));

        await sleep(100);
        const after = await page.evaluate(() => ({
          hash: location.hash,
          text: document.body.innerText,
          dialogs: [...document.querySelectorAll('[role="dialog"]')].map((d) => d.textContent),
        }));
        check(
          `missing record cannot retain invisible dirty guard ${action}`,
          after.hash === (action === 'tab-stats' ? '#/stats' : '#/history') && !after.text.includes('找不到这条记录'),
          after,
        );
      }
    } else if (suiteName === 'history-intent-contract') {
      const enter = async (single) => {
        await page.goto(baseUrl + (single ? '/?single=1' : ''));
        await page.waitForFunction(() => window.auditReady);
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '纠正数据'));
        await clickText('纠正数据');
        await page.waitForSelector('textarea');
        await page.$eval('textarea', (e) => e.select());
        await page.type('textarea', 'intent contract correction');
        await page.$eval('textarea', (e) => e.blur());
        await sleep(25);
      };

      for (const choice of ['放弃修改并离开', '保存修改并离开']) {
        await enter(false);
        const before = await page.evaluate(() => ({ hash: location.hash, length: history.length }));
        await page.evaluate(() => window.audit.navigate('/stats', true));
        await sleep(60);
        await clickText(choice);
        await sleep(100);

        let after = await page.evaluate(() => ({ hash: location.hash, length: history.length }));
        check(`confirmed replace intent preserves stack size ${choice}`, after.hash === '#/stats' && after.length === before.length, {
          before,
          after,
        });

        await page.evaluate(() => history.back());
        await sleep(100);
        after = await page.evaluate(() => ({ hash: location.hash, length: history.length }));
        check(`Back after confirmed replace skips replaced detail ${choice}`, after.hash === '#/history', after);

        await enter(true);
        const cdp = await page.createCDPSession();
        await cdp.send('Page.resetNavigationHistory');
        await cdp.detach();

        const single = await page.evaluate(() => ({ hash: location.hash, length: history.length }));
        check(`fallback case has one actual browser history entry ${choice}`, single.length === 1, single);

        await page.evaluate(() => window.audit.back('/settings'));
        await sleep(60);
        await clickText(choice);
        await sleep(100);

        after = await page.evaluate(() => ({ hash: location.hash, length: history.length }));
        check(
          `confirmed single-entry back honors requested fallback ${choice}`,
          after.hash === '#/settings' && after.length === 1,
          after,
        );
      }
    } else if (suiteName === 'history-delete') {
      const enter = async () => {
        await page.goto(baseUrl);
        await page.waitForFunction(() => window.auditReady);
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '纠正数据'));
        await clickText('纠正数据');
        await page.waitForSelector('textarea');
        await page.$eval('textarea', (e) => e.select());
        await page.type('textarea', 'dirty note before delete');
        await page.$eval('textarea', (e) => e.blur());
        await sleep(25);
      };

      const openDelete = async () => {
        await clickText('删除');
        await page.waitForFunction(() =>
          [...document.querySelectorAll('[role="dialog"]')].some((d) => d.textContent.includes('删除这条训练记录')),
        );
      };

      const confirmDelete = async () => {
        await page.evaluate(() => {
          const d = [...document.querySelectorAll('[role="dialog"]')].find((el) => el.textContent.includes('删除这条训练记录'));
          const b = [...d.querySelectorAll('button')].find((el) => el.textContent.trim() === '删除');
          b.click();
        });
        await sleep(120);
      };

      const capture = () =>
        page.evaluate(async () => ({
          hash: location.hash,
          note: document.querySelector('textarea')?.value,
          text: document.body.innerText,
          recordExists: !!(await window.audit.getSession(window.audit.id)),
          dialogs: [...document.querySelectorAll('[role="dialog"]')].map((d) => d.textContent),
        }));

      await enter();
      await openDelete();
      await confirmDelete();
      let s = await capture();
      check('dirty record deletion succeeds in database', s.recordExists === false, s);
      check('successful deletion exits detail rather than invisible guard trap', s.hash === '#/history' && !s.text.includes('找不到这条记录'), s);

      await page.click('a[href="#/stats"]');
      await sleep(100);
      s = await capture();
      check('after successful deletion Tab remains navigable', s.hash === '#/stats', s);

      await enter();
      await page.evaluate(() => (window.auditFailDelete = true));
      await openDelete();
      await confirmDelete();
      s = await capture();
      check('failed deletion preserves record and editable draft', s.recordExists && s.hash === '#/history/audit-history-a' && s.note === 'dirty note before delete', s);

      await page.evaluate(() => (window.auditFailDelete = false));
      await confirmDelete();
      s = await capture();
      check('delete retry succeeds and exits cleanly', !s.recordExists && s.hash === '#/history', s);
    } else if (suiteName === 'history-clean-ownership') {
      const waitEditButton = () =>
        page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '纠正数据'));
      const enter = async () => {
        await page.goto(baseUrl);
        await page.waitForFunction(() => window.auditReady);
        await waitEditButton();
        await clickText('纠正数据');
        await page.waitForSelector('textarea');
      };
      const changeNote = async (text) => {
        await page.$eval('textarea', (e) => e.select());
        await page.type('textarea', text);
        await page.$eval('textarea', (e) => e.blur());
        await sleep(30);
      };
      const route = () => page.evaluate(() => location.hash);
      const cleanLeave = async (name) => {
        await page.click('a[href="#/stats"]');
        await sleep(100);
        check(
          name,
          (await route()) === '#/stats' && (await page.$$eval('[role="dialog"]', (els) => els.length)) === 0,
          { hash: await route() },
        );
      };

      await enter();
      await cleanLeave('clean editing without changes permits leaving');

      await enter();
      await changeNote('temporary note');
      await changeNote('original note');
      await cleanLeave('note reverted to original permits leaving');

      await enter();
      await page.click('input');
      await page.$eval('input', (e) => e.select());
      await page.type('input', '25');
      await page.keyboard.press('Tab');
      await sleep(30);
      await page.click('input');
      await page.$eval('input', (e) => e.select());
      await page.type('input', '10');
      await page.keyboard.press('Tab');
      await sleep(30);
      await cleanLeave('number reverted to original permits leaving');

      await enter();
      await page.click('input');
      await page.$eval('input', (e) => e.select());
      await page.type('input', '-');
      await page.keyboard.press('Tab');
      await sleep(30);
      await page.click('input');
      await page.$eval('input', (e) => e.select());
      await page.type('input', '10');
      await page.keyboard.press('Tab');
      await sleep(30);
      await cleanLeave('invalid raw corrected to original permits leaving');

      await enter();
      await page.click('input');
      await page.$eval('input', (e) => e.select());
      await page.type('input', '-');
      await page.keyboard.press('Escape');
      await cleanLeave('invalid raw Escape cancellation permits leaving');

      await enter();
      await page.evaluate(() => window.audit.navigate('/history/' + window.audit.otherId));
      await page.waitForFunction(() => location.hash === '#/history/audit-history-b');
      await sleep(50);
      let view = await page.evaluate(() => ({
        hash: location.hash,
        note: document.querySelector('textarea')?.value,
        firstInput: document.querySelector('input')?.value,
        text: document.body.innerText,
      }));
      check(
        'clean A-to-B navigation never shows A draft under B',
        view.note === undefined || (view.note === 'second original note' && view.firstInput === '20'),
        view,
      );

      if ((await page.$$eval('textarea', (els) => els.length)) === 0) {
        await clickText('纠正数据');
        await page.waitForSelector('textarea');
      }
      await changeNote('record B correction');
      await clickText('保存修改');
      await sleep(100);
      let db = await page.evaluate(async () => ({
        a: await window.audit.getSession(window.audit.id),
        b: await window.audit.getSession(window.audit.otherId),
      }));
      check(
        'editing after clean A-to-B writes B and leaves A unchanged',
        db.a.note === 'original note' && db.b.note === 'record B correction',
        { aNote: db.a.note, bNote: db.b.note },
      );

      for (const choice of ['留在此页', '放弃修改并离开', '保存修改并离开']) {
        await enter();
        await changeNote('record A correction');
        await page.evaluate(() => window.audit.navigate('/history/' + window.audit.otherId));
        await sleep(80);
        const blocked = await page.evaluate(() => ({
          hash: location.hash,
          note: document.querySelector('textarea')?.value,
        }));
        check(
          `dirty A protects own draft before B choice ${choice}`,
          blocked.hash === '#/history/audit-history-a' && blocked.note === 'record A correction',
          blocked,
        );

        await clickText(choice);
        await sleep(120);
        view = await page.evaluate(() => ({
          hash: location.hash,
          note: document.querySelector('textarea')?.value,
          text: document.body.innerText,
        }));
        db = await page.evaluate(async () => ({
          a: await window.audit.getSession(window.audit.id),
          b: await window.audit.getSession(window.audit.otherId),
        }));
        check(
          `record ownership respected after ${choice}`,
          choice === '留在此页'
            ? view.hash === '#/history/audit-history-a' && view.note === 'record A correction' && db.a.note === 'original note'
            : view.hash === '#/history/audit-history-b' &&
                db.a.note === (choice === '保存修改并离开' ? 'record A correction' : 'original note') &&
                db.b.note === 'second original note' &&
                view.note === undefined,
          { view, aNote: db.a.note, bNote: db.b.note },
        );
      }
    } else if (suiteName === 'history-legal-raw') {
      const begin = async () => {
        await page.goto(baseUrl);
        await page.waitForFunction(() => window.auditReady);
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '纠正数据'));
        await clickText('纠正数据');
        await page.click('input');
        await page.$eval('input', (e) => e.select());
        await page.keyboard.type('25');
      };
      const physicalClickText = async (text) => {
        const handle = await page.evaluateHandle(
          (t) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === t),
          text,
        );
        await handle.asElement().click();
        await handle.dispose();
        await sleep(100);
      };

      await begin();
      await physicalClickText('保存修改');
      let db = await page.evaluate(() => window.audit.getSession(window.audit.id));
      check('focused valid raw commits before direct Save click', db.exercises[0].sets[0].reps === 25, {
        storedReps: db.exercises[0].sets[0].reps,
      });

      await begin();
      await page.click('a[href="#/stats"]');
      await sleep(100);
      const before = await page.evaluate(() => ({
        hash: location.hash,
        button: [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存修改并离开')?.disabled,
      }));
      check(
        'focused valid raw commits and enters leave confirmation on Tab',
        before.hash === '#/history/audit-history-a' && before.button === false,
        before,
      );
      if (before.button === false) await physicalClickText('保存修改并离开');
      db = await page.evaluate(() => window.audit.getSession(window.audit.id));
      check(
        'valid raw saves and leaves without permanent disable',
        db.exercises[0].sets[0].reps === 25 && (await page.evaluate(() => location.hash)) === '#/stats',
        { storedReps: db.exercises[0].sets[0].reps, hash: await page.evaluate(() => location.hash) },
      );

      await begin();
      await page.keyboard.press('Escape');
      await page.click('a[href="#/stats"]');
      await sleep(100);
      check(
        'Escape cancelled only raw edit permits clean leaving',
        (await page.evaluate(() => location.hash)) === '#/stats',
        { hash: await page.evaluate(() => location.hash) },
      );
    } else if (suiteName === 'history-forward') {
      for (const choice of ['放弃修改并离开', '保存修改并离开']) {
        await page.goto(baseUrl);
        await page.waitForFunction(() => window.auditReady);
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '纠正数据'));
        await page.evaluate(() => window.audit.navigate('/stats'));
        await page.waitForFunction(() => location.hash === '#/stats');
        await page.evaluate(() => history.back());
        await page.waitForFunction(() => location.hash === '#/history/audit-history-a');

        await clickText('纠正数据');
        await page.waitForSelector('textarea');
        await page.$eval('textarea', (e) => e.select());
        await page.type('textarea', 'forward pending correction');
        await page.$eval('textarea', (e) => e.blur());

        await page.evaluate(() => history.forward());
        await sleep(100);

        const blocked = await page.evaluate(() => ({
          hash: location.hash,
          note: document.querySelector('textarea')?.value,
          dialog: !!document.querySelector('[role="dialog"]'),
        }));
        check(
          `dirty Forward restores detail and retains draft ${choice}`,
          blocked.hash === '#/history/audit-history-a' && blocked.note === 'forward pending correction' && blocked.dialog,
          blocked,
        );

        await clickText(choice);
        await sleep(120);
        const after = await page.evaluate(() => ({ hash: location.hash, text: document.body.innerText }));
        check(`confirmed Forward continues forward rather than back ${choice}`, after.hash === '#/stats', after);
      }
    } else if (suiteName === 'history-dirty') {
      const open = async () => {
        await page.goto(baseUrl);
        await page.waitForFunction(() => window.auditReady || window.auditBootError);
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '纠正数据'));
        await clickText('纠正数据');
        await page.waitForSelector('textarea[aria-label="训练备注"]');
        await page.$eval('textarea[aria-label="训练备注"]', (e) => e.select());
        await page.type('textarea[aria-label="训练备注"]', 'unsaved correction');
        await page.$eval('textarea[aria-label="训练备注"]', (e) => e.blur());
      };

      const retained = () =>
        page.evaluate(() => ({
          hash: location.hash,
          note: document.querySelector('textarea[aria-label="训练备注"]')?.value,
          text: document.body.innerText,
        }));

      for (const action of ['tab', 'inline-history', 'inline-stats', 'browser-back', 'native-back']) {
        await open();
        if (action === 'tab') await page.click('a[href="#/stats"]');
        else if (action === 'inline-history') await clickText('‹ 历史');
        else if (action === 'inline-stats') await clickText('查看统计');
        else if (action === 'browser-back') await page.evaluate(() => history.back());
        else await page.evaluate(() => window.audit.handleBackIntent({ handleLayer: false }));

        await sleep(100);
        const s = await retained();
        check(`dirty history stays intact on ${action}`, s.hash === '#/history/audit-history-a' && s.note === 'unsaved correction', s);

        check(
          `leave choices offered on ${action}`,
          await page.$$eval('[role="dialog"]', (els) =>
            els.some((e) => e.textContent.includes('保存修改并离开') && e.textContent.includes('放弃修改并离开') && e.textContent.includes('留在此页')),
          ),
          await retained(),
        );

        await clickText('留在此页');
        const stayed = await retained();
        check(
          `explicit stay retains draft on ${action}`,
          stayed.hash === '#/history/audit-history-a' &&
            stayed.note === 'unsaved correction' &&
            (await page.$$eval('[role="dialog"]', (els) => els.length)) === 0,
          stayed,
        );
      }

      await open();
      await page.evaluate(() => (window.auditFailSave = true));
      await clickText('保存修改');
      await sleep(80);
      let s = await retained();
      const failedDb = await page.evaluate(() => window.audit.getSession(window.audit.id));
      check('failed save retains draft and original database', s.note === 'unsaved correction' && failedDb.note === 'original note', {
        s,
        databaseNote: failedDb.note,
      });

      await page.evaluate(() => (window.auditFailSave = false));
      await clickText('保存修改');
      await sleep(100);
      const savedDb = await page.evaluate(() => window.audit.getSession(window.audit.id));
      check(
        'save retry persists correction',
        savedDb.note === 'unsaved correction' && (await page.$$eval('textarea[aria-label="训练备注"]', (els) => els.length)) === 0,
        { databaseNote: savedDb.note },
      );

      await page.click('a[href="#/stats"]');
      await sleep(80);
      check('saved history can leave', (await page.evaluate(() => location.hash)) === '#/stats', await retained());

      await open();
      await clickText('取消');
      await page.click('a[href="#/stats"]');
      await sleep(80);
      check('explicit cancel permits leaving', (await page.evaluate(() => location.hash)) === '#/stats', await retained());

      await open();
      await page.evaluate(() => window.audit.holdWrites());
      await clickText('保存修改');
      await page.click('a[href="#/stats"]');
      await sleep(80);
      s = await retained();
      check('saving history cannot leave during pending transaction', s.hash === '#/history/audit-history-a' && s.note === 'unsaved correction', s);

      await page.evaluate(() => window.audit.releaseWrites());
      await page.waitForFunction(() => !document.querySelector('textarea[aria-label="训练备注"]'));
      check(
        'pending save completes after transaction released',
        (await page.evaluate(() => window.audit.getSession(window.audit.id))).note === 'unsaved correction',
        await retained(),
      );

      const attempt = async (action) => {
        if (action === 'tab') await page.click('a[href="#/stats"]');
        else if (action === 'inline-history') await clickText('‹ 历史');
        else if (action === 'inline-stats') await clickText('查看统计');
        else if (action === 'browser-back') await page.evaluate(() => history.back());
        else await page.evaluate(() => window.audit.handleBackIntent({ handleLayer: false }));
        await sleep(100);
      };

      for (const action of ['tab', 'inline-history', 'inline-stats', 'browser-back', 'native-back']) {
        for (const choice of ['放弃修改并离开', '保存修改并离开']) {
          await open();
          await attempt(action);
          await clickText(choice);
          await sleep(120);
          const after = await retained();
          const dbData = await page.evaluate(() => window.audit.getSession(window.audit.id));
          const target = action === 'tab' || action === 'inline-stats' ? '#/stats' : '#/history';
          check(`${action} ${choice} continues intended target`, after.hash === target, { after, databaseNote: dbData.note });
          check(
            `${action} ${choice} preserves expected DB`,
            dbData.note === (choice === '保存修改并离开' ? 'unsaved correction' : 'original note'),
            { databaseNote: dbData.note },
          );
          if (action === 'browser-back') {
            await page.evaluate(() => history.forward());
            await sleep(100);
            const forward = await retained();
            check(`Back then Forward retains original history detail ${choice}`, forward.hash === '#/history/audit-history-a', forward);
          }
        }
      }

      await open();
      await page.click('a[href="#/plans"]');
      await sleep(60);
      await clickText('留在此页');
      await clickText('查看统计');
      await clickText('放弃修改并离开');
      await sleep(100);
      s = await retained();
      check('cancelled Tab target cannot hijack later inline Stats discard', s.hash === '#/stats', s);

      await open();
      await page.click('a[href="#/plans"]');
      await sleep(60);
      await clickText('留在此页');
      await clickText('查看统计');
      await clickText('保存修改并离开');
      await sleep(100);
      s = await retained();
      check('cancelled Tab target cannot hijack later inline Stats save', s.hash === '#/stats', s);

      await open();
      await page.evaluate(() => (window.auditFailSave = true));
      await attempt('tab');
      await clickText('保存修改并离开');
      await sleep(100);
      s = await retained();
      let dbData = await page.evaluate(() => window.audit.getSession(window.audit.id));
      check(
        'modal save failure retains draft and original DB',
        s.hash === '#/history/audit-history-a' && s.note === 'unsaved correction' && dbData.note === 'original note',
        { s, databaseNote: dbData.note },
      );
      await page.evaluate(() => (window.auditFailSave = false));
      await clickText('‹ 历史');
      await clickText('放弃修改并离开');
      await sleep(100);
      s = await retained();
      check('failed save target cannot hijack next inline History discard', s.hash === '#/history', s);

      // Dirty note plus illegal raw number: modal Save must never drop that raw field.
      await open();
      await page.click('input');
      await page.$eval('input', (e) => e.select());
      await page.keyboard.type('-');
      await page.keyboard.press('Tab');
      await attempt('tab');
      const modalSave = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '保存修改并离开');
        return { present: !!b, disabled: b?.disabled };
      });
      check('invalid raw field disables modal save-and-leave', modalSave.present && modalSave.disabled, modalSave);
      if (modalSave.present && !modalSave.disabled) {
        await clickText('保存修改并离开');
        await sleep(100);
      }
      s = await retained();
      check(
        'invalid raw field cannot silently leave via modal Save',
        s.hash === '#/history/audit-history-a',
        { s, databaseNote: (await page.evaluate(() => window.audit.getSession(window.audit.id))).note },
      );

      // Raw-only illegal change has no committed patch yet, but still is a user draft.
      await page.goto(baseUrl);
      await page.waitForFunction(() => window.auditReady);
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '纠正数据'));
      await clickText('纠正数据');
      await page.click('input');
      await page.$eval('input', (e) => e.select());
      await page.keyboard.type('-');
      await page.keyboard.press('Tab');
      await page.click('a[href="#/stats"]');
      await sleep(100);
      s = await retained();
      check('raw-only invalid history edit is protected from Tab loss', s.hash === '#/history/audit-history-a', s);

      // Two actual pages edit the same synthetic DB record and exercise revision conflict.
      await open();
      const p2 = await browser.newPage();
      p2.on('pageerror', (e) => result.errors.push(`page2 ${String(e)}`));
      await p2.goto(`${baseUrl}/?reuse=1`);
      await p2.waitForFunction(() => window.auditReady);
      await p2.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '纠正数据'));
      await p2.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '纠正数据').click());
      await p2.waitForSelector('textarea');
      await p2.$eval('textarea', (e) => e.select());
      await p2.type('textarea', 'other page correction');
      await p2.$eval('textarea', (e) => e.blur());
      await p2.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存修改').click());
      await p2.waitForFunction(() => !document.querySelector('textarea'));

      await clickText('保存修改');
      await sleep(100);
      s = await retained();
      dbData = await page.evaluate(() => window.audit.getSession(window.audit.id));
      check(
        'second-page revision conflict preserves both committed and pending edits',
        s.note === 'unsaved correction' && dbData.note === 'other page correction',
        { s, databaseNote: dbData.note },
      );
      await p2.close();
    }

    check('no uncaught browser errors', result.errors.length === 0, result.errors);
  } catch (err) {
    result.harnessError = String(err?.stack || err);
    console.error(`  ✘ Harness error: ${result.harnessError}`);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    await new Promise((r) => server.close(r));
    result.pass = !result.harnessError && result.cases.length > 0 && result.cases.every((c) => c.ok);
    await writeFile(join(suiteOutDir, 'results.json'), JSON.stringify(result, null, 2));
  }

  return result;
}

async function main() {
  const chosenArg = process.argv[2] || 'all';
  const targetSuites = chosenArg === 'all' ? ALL_SUITES : [chosenArg];

  for (const s of targetSuites) {
    if (!ALL_SUITES.includes(s)) {
      console.error(`未知套件：${s}。可用套件：${ALL_SUITES.join(', ')}`);
      process.exit(1);
    }
  }

  const baseEvidenceDir = process.env.MOTION_UI_EVIDENCE_DIR
    ? resolve(process.env.MOTION_UI_EVIDENCE_DIR)
    : join(APP_DIR, 'verify-self/dom-regression');
  await mkdir(baseEvidenceDir, { recursive: true });

  console.log(`\n▶ 启动真实 DOM 缺陷回归测试套件（${targetSuites.length} 个套件）`);
  console.log(`  Chrome:   ${CHROME}`);
  console.log(`  Evidence: ${baseEvidenceDir}`);

  let totalCases = 0;
  let totalPass = 0;
  let hasFailure = false;
  const summary = {};

  for (const s of targetSuites) {
    console.log(`\n── 运行套件: ${s} ──`);
    const res = await runSingleSuite(s, baseEvidenceDir);
    const passed = res.cases.filter((c) => c.ok).length;
    const count = res.cases.length;
    totalCases += count;
    totalPass += passed;
    summary[s] = { pass: res.pass, passed, total: count };
    if (!res.pass) {
      hasFailure = true;
      console.log(`✘ 套件 ${s} 失败 (${passed}/${count} passed)`);
    } else {
      console.log(`✔ 套件 ${s} 通过 (${passed}/${count} passed)`);
    }
  }

  console.log('\n========================================');
  console.log(`DOM 回归总计: ${totalPass}/${totalCases} PASS`);
  console.log('套件明细:');
  for (const [k, v] of Object.entries(summary)) {
    console.log(`  - ${k}: ${v.pass ? 'PASS' : 'FAIL'} (${v.passed}/${v.total})`);
  }
  console.log('========================================\n');

  await writeFile(
    join(baseEvidenceDir, 'summary.json'),
    JSON.stringify({ timestamp: new Date().toISOString(), totalCases, totalPass, hasFailure, summary }, null, 2),
  );

  process.exit(hasFailure ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal runner error:', err);
  process.exit(1);
});
