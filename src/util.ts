import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export function positiveInt(value: string, name: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(value);
}

export function printJson(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }

export function selectFields(value: unknown, fields: string | boolean): unknown {
  if (typeof fields !== 'string' || !fields.trim()) return value;
  const selected = fields.split(',').map((field) => field.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.map((item) => selectFields(item, fields));
  return Object.fromEntries(selected.map((key) => [key, (value as Record<string, unknown>)[key]]));
}

export async function openBrowser(url: string): Promise<void> {
  if (!/^https?:\/\//.test(url)) throw new Error('Expected an HTTP or HTTPS browser URL.');
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  await promisify(execFile)(command, process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]);
}
