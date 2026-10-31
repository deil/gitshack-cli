import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

export type RepoRef = { path: string; host?: string };

export function parseRepo(input: string): RepoRef {
  const value = input.trim();
  let path = value;
  let host: string | undefined;
  const scp = value.includes('://') ? null : value.match(/^[^@\s]+@([^:/\s]+):(.+)$/);
  if (scp) {
    host = scp[1]; path = scp[2];
  } else if (value.includes('://')) {
    const url = new URL(value);
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || url.search || url.hash) {
      throw new Error('Use a GitLab project path or clone URL.');
    }
    host = url.protocol === 'ssh:' ? url.hostname : url.host;
    path = decodeURIComponent(url.pathname).replace(/^\//, '');
  }
  path = path.replace(/\/$/, '').replace(/\.git$/, '');
  if (path.split('/').length < 2 || path.split('/').some((part) => !part || part === '.' || part === '..' || /[\s?#:@\\]/.test(part)) || path.includes('/-/')) {
    throw new Error(`Unsupported GitLab project reference: ${input}`);
  }
  return { path, ...(host ? { host } : {}) };
}

export function validateRepo(ref: RepoRef, host: string): RepoRef {
  const instance = new URL(host);
  if (ref.host && ref.host !== instance.host && ref.host !== instance.hostname) {
    throw new Error(`Repository host ${ref.host} does not match ${instance.host}. Set GITLAB_HOST and authenticate for that instance.`);
  }
  // Self-managed instances may be installed under a relative URL root.
  const prefix = instance.pathname.replace(/^\/|\/$/g, '');
  return { ...ref, path: ref.host && prefix && ref.path.startsWith(`${prefix}/`) ? ref.path.slice(prefix.length + 1) : ref.path };
}

export async function tryGit(args: string[]): Promise<string | null> {
  try { return (await execFileAsync('git', args, { encoding: 'utf8' })).stdout.trim(); }
  catch { return null; }
}

export async function currentBranch(): Promise<string | null> { return tryGit(['branch', '--show-current']); }

export async function inferRepo(host: string): Promise<RepoRef> {
  const names = (await tryGit(['remote']))?.split('\n').filter(Boolean) ?? [];
  names.sort((a, b) => a === 'origin' ? -1 : b === 'origin' ? 1 : a.localeCompare(b));
  for (const name of names) {
    const remote = await tryGit(['remote', 'get-url', name]);
    if (!remote) continue;
    try {
      const ref = parseRepo(remote);
      if (!ref.host) continue;
      return validateRepo(ref, host);
    } catch { /* Try the next remote on the configured instance. */ }
  }
  throw new Error('Could not infer a GitLab project. Use -R group/project.');
}

export async function resolveRepo(input: string | undefined, host: string): Promise<RepoRef> {
  return input ? validateRepo(parseRepo(input), host) : inferRepo(host);
}
