import { existsSync } from 'node:fs';

/** Load .env into process.env (Node 22 built-in), silently if absent. */
export function loadEnv() {
  if (existsSync('.env')) {
    try {
      process.loadEnvFile('.env');
    } catch (err) {
      console.warn(`could not read .env: ${(err as Error).message}`);
    }
  }
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}
