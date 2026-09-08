import { execFile } from 'node:child_process';
import { platform } from 'node:os';

/** macOS desktop notification via osascript. No-op elsewhere or when disabled. */
export function notifyDesktop(title: string, body: string): void {
  if (process.env.NOTIFY_MACOS === '0') return;
  if (platform() !== 'darwin') return;
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`;
  execFile('osascript', ['-e', script], (err) => {
    if (err) console.warn(`  notification failed: ${err.message}`);
  });
}
