import { readFileSync } from 'node:fs'

// Read the real package version at runtime instead of hardcoding it.
// At runtime this resolves to <pkg root>/package.json from both dist/version.js
// and (under vitest) src/version.ts.
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }

export const VERSION: string = pkg.version
