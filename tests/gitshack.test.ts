import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createProgram } from '../src/cli.js';
import { configPath, deleteConfig, normalizeHost, readStoredConfig, requireConfig, writeConfig } from '../src/config.js';
import { parseRepo, validateRepo } from '../src/git.js';
import { ApiError, GitLabClient, projectPath } from '../src/gitlab.js';
import { normalizeState, parseTarget, validateInline } from '../src/mr.js';

const host = 'https://gitlab.example.test';
const config = { host, token: 'test-secret' };
const mrPath = '/api/v4/projects/team%2Fsub%2Frepo/merge_requests/42';
const mr = { id: 9001, iid: 42, title: 'Add export', state: 'opened', source_branch: 'feature', target_branch: 'main',
  web_url: `${host}/team/sub/repo/-/merge_requests/42`, sha: 'head',
  diff_refs: { base_sha: 'base', head_sha: 'head', start_sha: 'start' } };
let directory: string;
let environment: NodeJS.ProcessEnv;

beforeEach(async () => {
  environment = { ...process.env };
  directory = await mkdtemp(join(tmpdir(), 'gitshack-test-'));
  process.env.XDG_CONFIG_HOME = directory;
  process.env.GITLAB_HOST = host;
  process.env.GITLAB_TOKEN = config.token;
});
afterEach(async () => {
  process.env = environment;
  await rm(directory, { recursive: true, force: true });
});

function json(value: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
async function run(args: string[]): Promise<void> { await createProgram().parseAsync(args, { from: 'user' }); }

test('self-hosted instances are required, normalized, and may have relative URL roots', () => {
  assert.equal(normalizeHost('gitlab.example.test'), host);
  assert.equal(normalizeHost(`${host}/gitlab/`), `${host}/gitlab`);
  assert.throws(() => normalizeHost(''), /required/);
  assert.throws(() => normalizeHost('https://gitlab.com'), /self-hosted/);
  assert.throws(() => normalizeHost('https://www.gitlab.com'), /self-hosted/);
  for (const value of ['ftp://example.test', 'https://user:pass@example.test', `${host}?token=secret`, `${host}#fragment`]) {
    assert.throws(() => normalizeHost(value));
  }
});

test('config is isolated, private, and never reuses a token on a different host', async () => {
  await writeConfig(config);
  assert.deepEqual(await readStoredConfig(), config);
  assert.equal((await stat(configPath())).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'gitshack'))).mode & 0o777, 0o700);
  delete process.env.GITLAB_TOKEN;
  assert.deepEqual(await requireConfig(), config);
  process.env.GITLAB_HOST = 'https://other.example.test';
  await assert.rejects(requireConfig(), /Not logged in/);
  process.env.GITLAB_TOKEN = 'other-token';
  assert.deepEqual(await requireConfig(), { host: 'https://other.example.test', token: 'other-token' });
  await deleteConfig();
  assert.equal(await readStoredConfig(), null);
});

test('there is no implicit GitLab.com fallback', async () => {
  delete process.env.GITLAB_HOST;
  await assert.rejects(requireConfig(), /instance URL is required/);
});

test('nested projects, HTTPS, SCP, and SSH URLs parse correctly', () => {
  assert.deepEqual(parseRepo('team/sub/repo'), { path: 'team/sub/repo' });
  assert.deepEqual(parseRepo('git@gitlab.example.test:team/sub/repo.git'), { host: 'gitlab.example.test', path: 'team/sub/repo' });
  assert.deepEqual(parseRepo('ssh://git@gitlab.example.test:2222/team/sub/repo.git'), { host: 'gitlab.example.test', path: 'team/sub/repo' });
  assert.deepEqual(parseRepo(`${host}/team/sub/repo.git`), { host: 'gitlab.example.test', path: 'team/sub/repo' });
  assert.equal(projectPath('team/sub/repo'), '/projects/team%2Fsub%2Frepo');
  for (const value of ['repo', 'team//repo', 'team/../repo', 'team/repo/-/tree/main', 'team/repo?token=secret']) {
    assert.throws(() => parseRepo(value));
  }
});

test('repository host mismatches are refused and URL roots are stripped', () => {
  assert.throws(() => validateRepo(parseRepo('https://elsewhere.test/team/repo'), host), /does not match/);
  assert.equal(validateRepo(parseRepo(`${host}/gitlab/team/repo`), `${host}/gitlab`).path, 'team/repo');
  assert.equal(validateRepo(parseRepo('team/repo'), `${host}/gitlab`).path, 'team/repo');
});

test('merge request URLs use IIDs and nested project paths', () => {
  assert.equal(parseTarget('!42').iid, 42);
  assert.equal(parseTarget('#42').iid, 42);
  assert.deepEqual(parseTarget(mr.web_url), { iid: 42, repo: { host: 'gitlab.example.test', path: 'team/sub/repo' } });
  assert.throws(() => parseTarget('0'));
  assert.throws(() => parseTarget(`${host}/team/repo/-/issues/42`));
  assert.equal(normalizeState('open'), 'opened');
  assert.equal(normalizeState('all'), 'all');
  assert.throws(() => normalizeState('declined'));
});

test('client uses API v4, token auth, JSON bodies, and refuses redirects', async () => {
  const client = new GitLabClient({ ...config, host: `${host}/gitlab` }, async (input, init) => {
    assert.equal(String(input), `${host}/gitlab/api/v4/projects/team%2Frepo`);
    assert.equal((init?.headers as Record<string, string>)['PRIVATE-TOKEN'], config.token);
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, 'PUT');
    assert.deepEqual(JSON.parse(init?.body as string), { title: 'new' });
    return json({ ok: true });
  });
  assert.deepEqual(await client.requestJson('/projects/team%2Frepo', { method: 'PUT', body: { title: 'new' } }), { ok: true });
  for (const path of ['https://evil.test/api/v4/user', `${host}/other`, '../user']) assert.throws(() => client.buildUrl(path), /Refusing/);
});

test('pagination follows GitLab page headers and respects limits', async () => {
  const pages: string[] = [];
  const client = new GitLabClient(config, async (input) => {
    const url = new URL(String(input));
    pages.push(url.searchParams.get('page')!);
    assert.equal(url.searchParams.get('state'), 'opened');
    if (pages.length === 1) return json([{ iid: 1 }, { iid: 2 }], { 'x-next-page': '2' });
    assert.equal(url.searchParams.get('per_page'), '1');
    return json([{ iid: 3 }]);
  });
  assert.deepEqual(await client.paginate('/merge_requests?state=opened', 3), [{ iid: 1 }, { iid: 2 }, { iid: 3 }]);
  assert.deepEqual(pages, ['1', '2']);
});

test('client handles API errors, empty responses, and broken pagination', async () => {
  const client = new GitLabClient(config, async () => json({ message: { title: ['is required'] } }, {}, 422));
  await assert.rejects(client.requestJson('/projects'), (error: unknown) => error instanceof ApiError && error.status === 422 && /is required/.test(error.message));
  const empty = new GitLabClient(config, async () => new Response(null, { status: 204 }));
  assert.equal(await empty.requestJson('/projects'), undefined);
  const broken = new GitLabClient(config, async () => json([1], { 'x-next-page': '1' }));
  await assert.rejects(broken.paginate('/projects'), /repeated/);
});

test('pr exposes the original focused command set without an mr alias', () => {
  const program = createProgram();
  assert.equal(program.name(), 'gs-gitlab');
  assert.equal(program.version(), '0.1.0');
  assert.deepEqual(program.commands.map((item) => item.name()), ['auth', 'repo', 'pr']);
  const command = program.commands.find((item) => item.name() === 'pr')!;
  assert.deepEqual(command.aliases(), []);
  assert.deepEqual(command.commands.map((item) => item.name()), ['list', 'view', 'edit', 'create', 'diff', 'merge', 'close', 'comment', 'comments', 'review']);
});

test('package exposes only the gs-gitlab executable', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.bin, { 'gs-gitlab': 'dist/index.js' });
});

test('mr is rejected as an unknown command', async () => {
  const program = createProgram().exitOverride().configureOutput({ writeErr: () => {} });
  await assert.rejects(program.parseAsync(['mr', 'list'], { from: 'user' }), /unknown command 'mr'/);
});

test('pr returns native GitLab objects using scoped IID endpoints', async (t) => {
  const output: unknown[] = [];
  t.mock.method(console, 'log', (value) => output.push(value));
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    assert.equal(input.pathname, mrPath);
    return json(mr);
  });
  await run(['pr', 'view', '42', '-R', 'team/sub/repo', '--json']);
  assert.deepEqual(JSON.parse(output[0] as string), mr);
});

test('full MR URLs cannot redirect credentials to another instance or conflicting project', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected API call'); });
  await assert.rejects(run(['pr', 'view', 'https://evil.test/team/repo/-/merge_requests/42']), /does not match/);
  await assert.rejects(run(['pr', 'view', mr.web_url, '-R', 'different/repo']), /different projects/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('list validates state and limit, scopes to all project merge requests', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    assert.equal(url.searchParams.get('scope'), 'all');
    assert.equal(url.searchParams.get('state'), 'opened');
    assert.equal(url.searchParams.get('per_page'), '5');
    return json([mr]);
  });
  await run(['pr', 'list', '-R', 'team/sub/repo', '--limit', '5']);
  await assert.rejects(run(['pr', 'list', '-R', 'team/sub/repo', '--state', 'bogus']), /State/);
  await assert.rejects(run(['pr', 'list', '-R', 'team/sub/repo', '--limit', '0']), /positive integer/);
});

test('create uses project default branch and Draft title, not a fake draft property', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    if (init.method === 'GET') return json({ default_branch: 'main' });
    assert.equal(url.pathname, '/api/v4/projects/team%2Fsub%2Frepo/merge_requests');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body as string), { title: 'Draft: New', description: 'Body', source_branch: 'feature', target_branch: 'main' });
    return json(mr);
  });
  await run(['pr', 'create', '-R', 'team/sub/repo', '--head', 'feature', '--title', 'New', '--body', 'Body', '--draft']);
});

test('edit preserves an explicitly empty description', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
    assert.equal(init.method, 'PUT');
    assert.deepEqual(JSON.parse(init.body as string), { description: '' });
    return json(mr);
  });
  await run(['pr', 'edit', '42', '-R', 'team/sub/repo', '--body', '']);
  await assert.rejects(run(['pr', 'edit', '42', '-R', 'team/sub/repo']), /At least one/);
});

test('merge uses PUT with SHA guard, squash, and branch deletion', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    if (init.method === 'GET') return json(mr);
    assert.equal(url.pathname, `${mrPath}/merge`);
    assert.equal(init.method, 'PUT');
    assert.deepEqual(JSON.parse(init.body as string), { sha: 'head', squash: true, should_remove_source_branch: true });
    return json(mr);
  });
  await run(['pr', 'merge', '42', '-R', 'team/sub/repo', '--strategy', 'squash', '--close-source-branch']);
});

test('unsupported review and merge actions fail before making API calls', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected API call'); });
  await assert.rejects(run(['pr', 'review', '42', '--request-changes']), /not supported/);
  await assert.rejects(run(['pr', 'merge', '42', '--strategy', 'fast_forward']), /project settings/);
  await assert.rejects(run(['pr', 'review', '42', '--approve', '--comment']), /exactly one/);
  await assert.rejects(run(['pr', 'review', '42', '--comment']), /--body/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('approval includes source SHA and optional review body', async (t) => {
  t.mock.method(console, 'log', () => {});
  const mutations: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    if (init.method === 'GET') return json(mr);
    mutations.push(url.pathname);
    if (url.pathname.endsWith('/approve')) assert.deepEqual(JSON.parse(init.body as string), { sha: 'head' });
    else assert.deepEqual(JSON.parse(init.body as string), { body: 'Looks good' });
    return json({});
  });
  await run(['pr', 'review', '42', '-R', 'team/sub/repo', '--approve', '--body', 'Looks good']);
  assert.deepEqual(mutations, [`${mrPath}/notes`, `${mrPath}/approve`]);
});

test('close posts a comment then uses state_event close', async (t) => {
  t.mock.method(console, 'log', () => {});
  const methods: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
    methods.push(init.method!);
    assert.deepEqual(JSON.parse(init.body as string), init.method === 'POST' ? { body: 'Superseded' } : { state_event: 'close' });
    return json(mr);
  });
  await run(['pr', 'close', '42', '-R', 'team/sub/repo', '--comment', 'Superseded']);
  assert.deepEqual(methods, ['POST', 'PUT']);
});

test('inline argument validation distinguishes old and new sides', () => {
  assert.deepEqual(validateInline({ file: 'a.ts', line: '20' }), { newLine: 20, oldLine: undefined });
  assert.deepEqual(validateInline({ file: 'a.ts', from: '18' }), { newLine: undefined, oldLine: 18 });
  for (const options of [{ line: '20' }, { file: 'a.ts' }, { file: 'a.ts', line: '0' },
    { file: 'a.ts', line: '1', replyTo: '3' }, { file: 'a.ts', line: '1', to: '2' }]) {
    assert.throws(() => validateInline(options));
  }
});

test('inline discussions use native diff refs and renamed file paths', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    if (url.pathname.endsWith('/diffs')) return json([{ old_path: 'old.ts', new_path: 'new.ts', diff: '@@ -1 +1 @@\n-old\n+new' }]);
    if (init.method === 'GET') return json(mr);
    assert.equal(url.pathname, `${mrPath}/discussions`);
    assert.deepEqual(JSON.parse(init.body as string), { body: 'Check this', position: {
      position_type: 'text', ...mr.diff_refs, old_path: 'old.ts', new_path: 'new.ts', new_line: 20,
    } });
    return json({});
  });
  await run(['pr', 'comment', '42', '-R', 'team/sub/repo', '--body', 'Check this', '--file', 'new.ts', '--line', '20']);
});

test('reply-to resolves a note ID to its native discussion', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    if (init.method === 'GET') return json([{ id: 'discussion-hash', notes: [{ id: 123, body: 'Original' }] }]);
    assert.equal(url.pathname, `${mrPath}/discussions/discussion-hash/notes`);
    assert.deepEqual(JSON.parse(init.body as string), { body: 'Fixed' });
    return json({});
  });
  await run(['pr', 'comment', '42', '-R', 'team/sub/repo', '--body', 'Fixed', '--reply-to', '123']);
});

test('diff statistics count actual additions including content starting with plus signs', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => lines.push(line));
  t.mock.method(globalThis, 'fetch', async () => json([{ old_path: 'a', new_path: 'a', diff: '@@ -1 +1,2 @@\n-before\n+after\n+++content' }]));
  await run(['pr', 'diff', '42', '-R', 'team/sub/repo', '--stat']);
  assert.match(lines[1], /a\s+2\s+1/);
});

test('repo listing supports group subgroups and native field selection', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => lines.push(line));
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    if (!url.pathname.endsWith('/projects')) return json({ id: 1 });
    assert.equal(url.pathname, '/api/v4/groups/team%2Fsub/projects');
    assert.equal(url.searchParams.get('include_subgroups'), 'true');
    assert.equal(url.searchParams.get('visibility'), 'private');
    return json([{ id: 1, path_with_namespace: 'team/sub/repo', visibility: 'private' }]);
  });
  await run(['repo', 'list', 'team/sub', '--visibility', 'private', '--json', 'path_with_namespace']);
  assert.deepEqual(JSON.parse(lines[0]), [{ path_with_namespace: 'team/sub/repo' }]);
});

test('repository JSON view does not make README requests', async (t) => {
  t.mock.method(console, 'log', () => {});
  const fetch = t.mock.method(globalThis, 'fetch', async () => json({ id: 1, path_with_namespace: 'team/sub/repo' }));
  await run(['repo', 'view', 'team/sub/repo', '--json']);
  assert.equal(fetch.mock.callCount(), 1);
});

test('config serialization never writes into the original CLI directory', async () => {
  await writeConfig(config);
  assert.match(configPath(), /gitshack\/config.json$/);
  assert.deepEqual(JSON.parse(await readFile(configPath(), 'utf8')), config);
});

test('current branch inference skips off-host origin and uses matching GitLab remotes', async (t) => {
  const exec = promisify(execFile);
  await exec('git', ['init', '-b', 'feature'], { cwd: directory });
  await exec('git', ['remote', 'add', 'origin', 'https://other.example.test/team/repo.git'], { cwd: directory });
  await exec('git', ['remote', 'add', 'upstream', `${host}/team/sub/repo.git`], { cwd: directory });
  const previous = process.cwd();
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    if (url.pathname.endsWith('/merge_requests')) {
      assert.equal(url.pathname, '/api/v4/projects/team%2Fsub%2Frepo/merge_requests');
      assert.equal(url.searchParams.get('source_branch'), 'feature');
      return json([mr]);
    }
    assert.equal(url.pathname, mrPath);
    return json(mr);
  });
  try {
    process.chdir(directory);
    await run(['pr', 'view', '--json']);
  } finally { process.chdir(previous); }
});

test('ambiguous current branch merge requests fail instead of choosing a target', async (t) => {
  await promisify(execFile)('git', ['init', '-b', 'feature'], { cwd: directory });
  t.mock.method(globalThis, 'fetch', async () => json([mr, { ...mr, iid: 43 }]));
  const previous = process.cwd();
  try {
    process.chdir(directory);
    await assert.rejects(run(['pr', 'view', '-R', 'team/sub/repo']), /Multiple open merge requests/);
  } finally { process.chdir(previous); }
});

test('repository README encodes refs and files and does not hide permission errors', async (t) => {
  const output: string[] = [];
  t.mock.method(console, 'log', (line: string) => output.push(line));
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    if (!url.pathname.includes('/repository/files/')) return json({ id: 1, path_with_namespace: 'team/sub/repo', default_branch: 'main', web_url: host });
    assert.equal(url.searchParams.get('ref'), 'feature/a');
    assert.equal(url.pathname, '/api/v4/projects/team%2Fsub%2Frepo/repository/files/README.md/raw');
    return new Response('# Hello');
  });
  await run(['repo', 'view', 'team/sub/repo', '--branch', 'feature/a']);
  assert.equal(output.at(-1), '\n# Hello');
  t.mock.method(globalThis, 'fetch', async (url: URL) => url.pathname.includes('/repository/files/')
    ? json({ message: 'Forbidden' }, {}, 403)
    : json({ default_branch: 'main' }));
  await assert.rejects(run(['repo', 'view', 'team/sub/repo']), /403/);
});

test('missing source SHA never permits an unguarded merge or approval', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => json({ ...mr, sha: undefined }));
  await assert.rejects(run(['pr', 'merge', '42', '-R', 'team/sub/repo']), /unguarded merge/);
  await assert.rejects(run(['pr', 'review', '42', '-R', 'team/sub/repo', '--approve']), /unguarded approval/);
  assert.equal(fetch.mock.callCount(), 2);
});

test('diff statistics refuse omitted file diffs', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json([{ new_path: 'huge', diff: '', too_large: true }]));
  await assert.rejects(run(['pr', 'diff', '42', '-R', 'team/sub/repo', '--stat']), /complete statistics/);
});

test('CLI login validates stdin tokens before saving, status verifies, and logout removes credentials', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, '/gitlab/api/v4/user');
    const accepted = request.headers['private-token'] === 'valid-test-token';
    response.writeHead(accepted ? 200 : 401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(accepted ? { id: 1, username: 'tester' } : { message: 'Unauthorized' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const instance = `http://127.0.0.1:${address.port}/gitlab`;
  delete process.env.GITLAB_TOKEN;
  delete process.env.GITLAB_HOST;
  const cli = (args: string[], stdin = '') => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/index.ts', import.meta.url)), ...args], { env: process.env });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
  try {
    const invalid = await cli(['auth', 'login', '--hostname', instance, '--with-token'], 'invalid-test-token');
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /401/);
    assert.equal(await readStoredConfig(), null);
    const login = await cli(['auth', 'login', '--hostname', instance, '--with-token'], 'valid-test-token\n');
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, /as tester/);
    assert.ok(!login.stdout.includes('valid-test-token'));
    assert.deepEqual(await readStoredConfig(), { host: instance, token: 'valid-test-token' });
    const status = await cli(['auth', 'status']);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /logged in as tester/);
    assert.equal((await cli(['auth', 'logout'])).code, 0);
    assert.equal(await readStoredConfig(), null);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
