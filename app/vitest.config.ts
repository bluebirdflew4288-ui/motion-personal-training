import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/._*'],
    environment: 'node',
    globals: true,
  },
  /**
   * 与 vite.config.ts 保持一致：提供构建期常量，否则 src/lib/platform.ts 里的
   * `typeof __MOTION_NATIVE__ !== 'undefined'` 在测试环境恒为 false，
   * 导致原生文件桥相关分支（v0.1.2 导出修复）无法被测试覆盖。
   * 默认按 android 目标注入 true；需要测 web 行为的用例可用 vi.stubGlobal 覆盖 Capacitor。
   */
  define: {
    __MOTION_NATIVE__: JSON.stringify(true),
    __MOTION_BUILD_TARGET__: JSON.stringify('android'),
  },
});
