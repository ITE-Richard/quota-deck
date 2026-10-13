const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'info',
};

/**
 * 測試用打包：每個 test/*.test.ts 各自打成一支可直接給 `node --test` 跑的檔案，
 * 並把 `vscode` 換成 test/vscode-stub.ts，讓純函式的 parser 不必啟動 VSCode 就能測。
 */
function testOptions() {
  const entryPoints = fs
    .readdirSync('test')
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => path.join('test', name));
  return {
    entryPoints,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outdir: 'out/test',
    alias: { vscode: './test/vscode-stub.ts' },
    sourcemap: 'inline',
    logLevel: 'warning',
  };
}

async function main() {
  if (test) {
    fs.rmSync('out/test', { recursive: true, force: true });
    await esbuild.build(testOptions());
  } else if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[esbuild] watching…');
  } else {
    await esbuild.build(options);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
