import type { Config } from './config.js';

export type User = { id: number; username: string; name?: string };
export type Project = {
  id: number; path_with_namespace: string; description?: string; visibility: string;
  default_branch?: string; web_url: string; readme_url?: string | null;
  archived?: boolean; created_at?: string; last_activity_at?: string;
};
export type MergeRequest = {
  id: number; iid: number; title: string; description?: string; state: string;
  source_branch: string; target_branch: string; web_url: string; author?: User;
  created_at?: string; updated_at?: string; sha?: string;
  diff_refs?: { base_sha: string; head_sha: string; start_sha: string };
};
export type Note = { id: number; body: string; author?: User; system?: boolean; position?: Record<string, unknown> };
export type Discussion = { id: string; notes: Note[] };
export type Diff = { old_path: string; new_path: string; diff: string; collapsed?: boolean; too_large?: boolean };
type RequestOptions = { method?: string; body?: unknown; headers?: Record<string, string> };

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export class GitLabClient {
  constructor(readonly config: Config, private readonly fetcher: typeof fetch = fetch) {}

  buildUrl(path: string): URL {
    const base = `${this.config.host}/api/v4/`;
    const url = new URL(path.replace(/^\//, ''), base);
    if (url.origin !== new URL(base).origin || !url.pathname.startsWith(new URL(base).pathname)) {
      throw new Error('Refusing to send GitLab credentials outside the configured API.');
    }
    return url;
  }

  async request(path: string, options: RequestOptions = {}): Promise<Response> {
    const response = await this.fetcher(this.buildUrl(path), {
      method: options.method ?? 'GET',
      headers: { Accept: 'application/json', ...options.headers, 'PRIVATE-TOKEN': this.config.token,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'error',
    });
    if (!response.ok) {
      const text = await response.text();
      let message = text || response.statusText;
      try {
        const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
        const detail = parsed.message ?? parsed.error;
        if (detail) message = typeof detail === 'string' ? detail : JSON.stringify(detail);
      } catch { /* Keep non-JSON errors readable. */ }
      throw new ApiError(response.status, `GitLab API ${response.status}: ${message}`);
    }
    return response;
  }

  async requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(path, options);
    return response.status === 204 ? undefined as T : await response.json() as T;
  }

  async requestText(path: string): Promise<string> { return (await this.request(path)).text(); }

  async paginate<T>(path: string, limit = Infinity): Promise<T[]> {
    const values: T[] = [];
    const url = this.buildUrl(path);
    let page = '1';
    const seen = new Set<string>();
    while (values.length < limit) {
      if (seen.has(page)) throw new Error('GitLab returned a repeated pagination page.');
      seen.add(page);
      url.searchParams.set('page', page);
      url.searchParams.set('per_page', String(Math.min(100, limit - values.length)));
      const response = await this.request(url.toString());
      const items = await response.json() as T[];
      if (!Array.isArray(items)) throw new Error('Expected a GitLab list response.');
      values.push(...items);
      const next = response.headers.get('x-next-page');
      if (!next) break;
      if (!/^\d+$/.test(next)) throw new Error('GitLab returned an invalid pagination page.');
      page = next;
    }
    return values.slice(0, limit);
  }
}

export function projectPath(path: string, suffix = ''): string { return `/projects/${encodeURIComponent(path)}${suffix}`; }
