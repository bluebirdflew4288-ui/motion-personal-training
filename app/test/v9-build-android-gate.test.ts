import { describe, it, expect, vi } from 'vitest';
import {
  resolveAndroidSdk,
  validateStaticAssets,
  runPreflightGate,
  executeAndroidBuild,
  motionProjectKey,
} from '../scripts/build-android.mjs';

describe('build-android SDK 与静态门禁边界', () => {
  describe('resolveAndroidSdk', () => {
    it('当 ANDROID_HOME 与 ANDROID_SDK_ROOT 均未配置时返回失败', () => {
      const res = resolveAndroidSdk({}, (_p: string) => true);
      expect(res.ok).toBe(false);
      expect(res.error).toContain('未设置 ANDROID_HOME / ANDROID_SDK_ROOT');
    });

    it('当配置的 SDK 路径不存在时返回失败', () => {
      const res = resolveAndroidSdk({ ANDROID_HOME: '/non/existent/sdk' }, (_p: string) => false);
      expect(res.ok).toBe(false);
      expect(res.error).toContain('路径不存在');
    });

    it('当 SDK 路径真实存在时返回成功并优先使用 ANDROID_HOME', () => {
      const res = resolveAndroidSdk(
        { ANDROID_HOME: '/valid/home', ANDROID_SDK_ROOT: '/valid/root' },
        (p: string) => p === '/valid/home',
      );
      expect(res.ok).toBe(true);
      expect(res.path).toBe('/valid/home');
    });

    it('无 ANDROID_HOME 时正确 fallback 到存在的 ANDROID_SDK_ROOT', () => {
      const res = resolveAndroidSdk(
        { ANDROID_SDK_ROOT: '/valid/root' },
        (p: string) => p === '/valid/root',
      );
      expect(res.ok).toBe(true);
      expect(res.path).toBe('/valid/root');
    });
  });

  describe('validateStaticAssets', () => {
    const validBuiltHtml = '<!doctype html><script src="assets/index-ABC123_.js"></script>';
    const validPackedHtml = '<!doctype html><script src="assets/index-ABC123_.js"></script>';
    const validConfig = 'export default { appId: "app.motion.personal" };';

    it('完整匹配且无远程引用时验证通过', () => {
      const res = validateStaticAssets({
        builtHtml: validBuiltHtml,
        packedHtml: validPackedHtml,
        capacitorConfigContent: validConfig,
      });
      expect(res.ok).toBe(true);
      expect(res.errors).toHaveLength(0);
      expect(res.builtScript).toBe('index-ABC123_.js');
      expect(res.packedScript).toBe('index-ABC123_.js');
    });

    it('构建产物中缺少入口脚本时拦截', () => {
      const res = validateStaticAssets({
        builtHtml: '<!doctype html><div>no script</div>',
        packedHtml: validPackedHtml,
        capacitorConfigContent: validConfig,
      });
      expect(res.ok).toBe(false);
      expect(res.errors.some((e: string) => e.includes('找不到入口脚本'))).toBe(true);
    });

    it('打包脚本与构建脚本 hash 不匹配时拦截', () => {
      const res = validateStaticAssets({
        builtHtml: validBuiltHtml,
        packedHtml: '<!doctype html><script src="assets/index-OLD999_.js"></script>',
        capacitorConfigContent: validConfig,
      });
      expect(res.ok).toBe(false);
      expect(res.errors.some((e: string) => e.includes('与本次构建不一致'))).toBe(true);
    });

    it('capacitor.config 中存在远程 server.url 时拦截', () => {
      const res = validateStaticAssets({
        builtHtml: validBuiltHtml,
        packedHtml: validPackedHtml,
        capacitorConfigContent: 'server: { url: "http://192.168.1.100:5199" }',
      });
      expect(res.ok).toBe(false);
      expect(res.errors.some((e: string) => e.includes('禁止远程加载'))).toBe(true);
    });

    it('打包 HTML 中出现 http(s) 外链时拦截', () => {
      const res = validateStaticAssets({
        builtHtml: validBuiltHtml,
        packedHtml: '<!doctype html><link href="https://fonts.googleapis.com/css"><script src="assets/index-ABC123_.js"></script>',
        capacitorConfigContent: validConfig,
      });
      expect(res.ok).toBe(false);
      expect(res.errors.some((e: string) => e.includes('仍有远程引用'))).toBe(true);
    });
  });

  describe('runPreflightGate 失败顺序与熔断', () => {
    it('SDK 不存在时首项立即熔断，不执行任何下游命令', () => {
      const runFn = vi.fn();
      expect(() =>
        runPreflightGate({
          env: {},
          existsFn: () => false,
          runFn,
        }),
      ).toThrow('未设置 ANDROID_HOME / ANDROID_SDK_ROOT');

      expect(runFn).not.toHaveBeenCalled();
    });

    it('类型检查失败时立即中止，不执行单元测试和纯 JVM 测试', () => {
      const callLog: string[] = [];
      const runFn = vi.fn((cmd: string, args: string[]) => {
        const full = `${cmd} ${args.join(' ')}`;
        callLog.push(full);
        if (args.includes('typecheck')) {
          throw new Error('Typecheck error: TS2322');
        }
      });

      expect(() =>
        runPreflightGate({
          env: { ANDROID_HOME: '/mock/sdk' },
          existsFn: () => true,
          runFn,
        }),
      ).toThrow('TS2322');

      expect(callLog).toEqual(['npm run typecheck']);
      expect(runFn).toHaveBeenCalledTimes(1);
    });

    it('单元测试失败时立即中止，不执行纯 JVM 测试', () => {
      const callLog: string[] = [];
      const runFn = vi.fn((cmd: string, args: string[]) => {
        const full = `${cmd} ${args.join(' ')}`;
        callLog.push(full);
        if (args.includes('test') && !args.includes('android:test:java')) {
          throw new Error('Unit test failed: 1 failure');
        }
      });

      expect(() =>
        runPreflightGate({
          env: { ANDROID_HOME: '/mock/sdk' },
          existsFn: () => true,
          runFn,
        }),
      ).toThrow('Unit test failed');

      expect(callLog).toEqual(['npm run typecheck', 'npm run test']);
      expect(runFn).toHaveBeenCalledTimes(2);
    });

    it('全部前置门禁按次序依次执行且成功', () => {
      const callLog: string[] = [];
      const runFn = vi.fn((cmd: string, args: string[]) => {
        callLog.push(`${cmd} ${args.join(' ')}`);
      });

      const res = runPreflightGate({
        env: { ANDROID_HOME: '/mock/sdk' },
        existsFn: () => true,
        runFn,
      });

      expect(res.sdk).toBe('/mock/sdk');
      expect(callLog).toEqual([
        'npm run typecheck',
        'npm run test',
        'npm run android:test:java',
      ]);
    });
  });

  describe('executeAndroidBuild 编排安全保障', () => {
    it('前置自检失败时绝不触碰文件清理、Vite 构建、Cap sync 或 Gradle', () => {
      const stripFn = vi.fn();
      const runFn = vi.fn();

      expect(() =>
        executeAndroidBuild({
          env: {}, // missing SDK
          existsFn: () => false,
          runFn,
          stripFn,
          appDir: '/mock/app',
        }),
      ).toThrow();

      expect(stripFn).not.toHaveBeenCalled();
      expect(runFn).not.toHaveBeenCalled();
    });

    it('静态自检失败时立即中止，绝不继续调用 Gradle assemble', () => {
      const runLog: string[] = [];
      const runFn = vi.fn((cmd: string, args: string[]) => {
        runLog.push(`${cmd} ${args.join(' ')}`);
      });

      expect(() =>
        executeAndroidBuild({
          env: { ANDROID_HOME: '/mock/sdk' },
          argv: ['node', 'scripts/build-android.mjs'],
          existsFn: (p: string) => {
            if (p === '/mock/sdk') return true;
            if (p.endsWith('index.html')) return true;
            if (p.endsWith('sw.js')) return false;
            return false;
          },
          runFn,
          stripFn: vi.fn(),
          readFn: (p: string) => {
            if (p.includes('dist-android/index.html')) {
              return '<script src="assets/index-NEW1.js"></script>';
            }
            if (p.includes('assets/public/index.html')) {
              return '<script src="assets/index-OLD2.js"></script>'; // mismatch!
            }
            return 'export default {};';
          },
          appDir: '/mock/app',
        }),
      ).toThrow('静态自检失败');

      // Gradle assembleDebug 绝不被调用
      expect(runLog.some((cmd) => cmd.includes('assemble'))).toBe(false);
    });
  });

  describe('motionProjectKey 构建目录指纹', () => {
    it('针对已知路径生成稳定一致的指纹格式', () => {
      const key = motionProjectKey(process.cwd());
      expect(key).toMatch(/^[A-Za-z0-9._-]+-[a-f0-9]{12}$/);
    });
  });
});
