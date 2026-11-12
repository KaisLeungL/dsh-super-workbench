import { defineConfig } from 'tsdown';
export default defineConfig([
  { entry: { index: 'src/index.ts', preset: 'src/sessions/preset.ts' }, outDir: 'lib', format: 'esm', platform: 'node', target: 'es2024', dts: false, clean: false, fixedExtension: false, deps: { neverBundle: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-session'] } },
  { entry: { client: 'src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser', target: 'es2022', dts: false, clean: false, deps: { neverBundle: ['react'] },
    loader: { '.png': 'dataurl' },
    outputOptions: { entryFileNames: 'client.js', banner: 'window.__ModuleLoader__.load({ id: "@local/dsh-workspace-superagent", factory: (require) => {', intro: 'var module = { exports: {} }; var exports = module.exports;', footer: 'return module.exports; } });' } }
]);
