import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

let rl: ReturnType<typeof createInterface> | null = null;

function iface() {
  if (!rl) rl = createInterface({ input: stdin, output: stdout });
  return rl;
}

export async function ask(question: string): Promise<string> {
  const answer = await iface().question(question);
  return answer.trim();
}

export function closePrompt() {
  rl?.close();
  rl = null;
}

export const color = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};
