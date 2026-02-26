// esbuild configuration for frontend bundle
import { build, context } from 'esbuild';

const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: ['public/js/main.js'],
  bundle: true,
  outfile: 'public/dist/bundle.js',
  format: 'esm',
  sourcemap: true,
  minify: !isWatch,
  target: ['es2020'],
  resolveExtensions: ['.ts', '.js'],
  logLevel: 'info',
};

if (isWatch) {
  const ctx = await context(config);
  await ctx.watch();
  console.log('👀 Watching for changes...');
} else {
  await build(config);
}
