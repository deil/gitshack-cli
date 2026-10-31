import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type Config = { host: string; token: string };

export function normalizeHost(value: string): string {
  if (!value.trim()) throw new Error('A self-hosted GitLab instance URL is required. Set GITLAB_HOST or use --hostname.');
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Host must be an HTTP or HTTPS GitLab instance URL without credentials, query, or fragment.');
  }
  if (url.hostname === 'gitlab.com' || url.hostname.endsWith('.gitlab.com')) {
    throw new Error('gs-gitlab supports self-hosted GitLab only. Use your own instance URL.');
  }
  return url.toString().replace(/\/+$/, '');
}

export function configPath(): string {
  return join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'gitshack', 'config.json');
}

export async function readStoredConfig(): Promise<Config | null> {
  try {
    const value = JSON.parse(await readFile(configPath(), 'utf8')) as Partial<Config>;
    if (!value || typeof value.host !== 'string' || typeof value.token !== 'string' || !value.token.trim()) {
      throw new Error('Invalid gitshack config. Run `gs-gitlab auth login` again.');
    }
    return { host: normalizeHost(value.host), token: value.token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function requireConfig(): Promise<Config> {
  const stored = await readStoredConfig();
  const host = normalizeHost(process.env.GITLAB_HOST?.trim() || stored?.host || '');
  const token = process.env.GITLAB_TOKEN?.trim() || (stored?.host === host ? stored.token : undefined);
  if (!token) throw new Error(`Not logged in to ${host}. Run \`gs-gitlab auth login\` or set GITLAB_HOST and GITLAB_TOKEN.`);
  return { host, token };
}

export async function writeConfig(config: Config): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function deleteConfig(): Promise<void> {
  await rm(configPath(), { force: true });
}
