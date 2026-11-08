import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts', react: 'src/react.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    external: ['react'],
  },
  {
    // Script-tag build: <script src=".../peanut-gallery.global.js"> then PeanutGallery.init({...})
    entry: { 'peanut-gallery': 'src/global.ts' },
    format: ['iife'],
    globalName: 'PeanutGallery',
    minify: true,
    noExternal: ['@pixelatlarge/peanut-gallery-core'],
    outExtension: () => ({ js: '.global.js' }),
  },
]);
