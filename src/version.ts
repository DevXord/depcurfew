import { readFileSync } from 'node:fs';

// Resolves to the package root both from src/ (tests) and from dist/ (built bundle).
const PACKAGE_JSON = new URL('../package.json', import.meta.url);

let cached: string | undefined;

export function getVersion(): string {
  cached ??= (JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version: string }).version;
  return cached;
}
