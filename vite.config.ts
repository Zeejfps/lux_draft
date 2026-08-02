import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import checker from 'vite-plugin-checker';
import { execSync } from 'child_process';

function getGitVersion(): string {
  try {
    // Get the most recent tag, or fall back to 'dev' if no tags exist
    return execSync('git describe --tags --abbrev=0', { encoding: 'utf-8' }).trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  plugins: [
    svelte(),
    checker({
      typescript: true,
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(getGitVersion()),
  },
  build: {
    // `scripts/check-bundle.mjs` walks the manifest's static `imports` to work out exactly
    // which chunks the browser fetches before it can render, and asserts what may and may not
    // be in them (invariant 7). Without the manifest that graph is only recoverable by parsing
    // the emitted JS.
    manifest: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
  },
});
