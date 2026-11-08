// Builds the static demo into demo/dist: deploy that folder anywhere (GitHub Pages, Netlify, Vercel).
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: { main: join(here, 'src/main.ts'), checkout: join(here, 'src/prototype.ts') },
  outdir: out,
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  // Resolve workspace packages from source so the demo always matches the repo.
  alias: {
    '@peanut-gallery/core': join(here, '../packages/core/src/index.ts'),
    '@peanut-gallery/widget': join(here, '../packages/widget/src/index.ts'),
  },
});
for (const f of ['index.html', 'checkout.html', 'checkout.css']) cpSync(join(here, f), join(out, f));
cpSync(join(here, 'assets'), join(out, 'assets'), { recursive: true });
console.log('demo built → demo/dist');
