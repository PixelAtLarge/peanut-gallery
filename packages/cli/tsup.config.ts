import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { cli: 'src/cli.ts', index: 'src/index.ts' },
    format: ['esm'],
    dts: { entry: { index: 'src/index.ts' } },
    clean: true,
    platform: 'node',
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
    external: ['playwright', '@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk'],
  },
  {
    // Injected into pages by Playwright to resolve anchors with the same logic as the widget.
    entry: { 'anchor-inject': 'src/browser/anchor-inject.ts' },
    format: ['iife'],
    platform: 'browser',
    minify: true,
    noExternal: ['@pixelatlarge/peanut-gallery-core'],
    outExtension: () => ({ js: '.global.js' }),
  },
]);
