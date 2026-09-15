const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const withSourcemap = process.argv.includes('--sourcemap'); // 生产打包默认不出 map(281KB 源码不进 vsix)

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: watch || withSourcemap,
  minify: false,
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[esbuild] watching...');
  } else {
    await esbuild.build(options);
    console.log('[esbuild] build done');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
