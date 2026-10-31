import { Command } from 'commander';
import { requireConfig } from './config.js';
import { GitLabClient, projectPath, type MergeRequest, type Discussion, type Diff } from './gitlab.js';
import { currentBranch, parseRepo, resolveRepo, validateRepo, type RepoRef } from './git.js';
import { printDiscussions, printMergeRequest, printMergeRequests, printTable } from './format.js';
import { positiveInt, printJson } from './util.js';

type RepoOptions = { repo?: string };
type CommentOptions = RepoOptions & { body: string; file?: string; line?: string; to?: string; from?: string; replyTo?: string };

export function parseTarget(target?: string): { iid?: number; repo?: RepoRef } {
  if (!target) return {};
  if (/^[!#]?\d+$/.test(target)) return { iid: positiveInt(target.replace(/^[!#]/, ''), 'merge request number') };
  let url: URL;
  try { url = new URL(target); }
  catch { throw new Error('Use a merge request number or GitLab merge request URL.'); }
  const match = url.pathname.match(/^\/(.+)\/-\/merge_requests\/(\d+)\/?$/);
  if (!match || !['http:', 'https:'].includes(url.protocol)) throw new Error('Use a merge request number or GitLab merge request URL.');
  return { iid: positiveInt(match[2], 'merge request number'), repo: parseRepo(`${url.origin}/${match[1]}`) };
}

export function normalizeState(value: string): string {
  const state = value.toLowerCase();
  if (state === 'open') return 'opened';
  if (['opened', 'closed', 'merged', 'all'].includes(state)) return state;
  throw new Error('State must be open, opened, closed, merged, or all.');
}

async function context(input?: string): Promise<{ client: GitLabClient; repo: RepoRef; path: string }> {
  const client = new GitLabClient(await requireConfig());
  const repo = await resolveRepo(input, client.config.host);
  return { client, repo, path: projectPath(repo.path) };
}

async function targetContext(target: string | undefined, options: RepoOptions) {
  const parsed = parseTarget(target);
  const client = new GitLabClient(await requireConfig());
  const repo = parsed.repo ? validateRepo(parsed.repo, client.config.host) : await resolveRepo(options.repo, client.config.host);
  if (parsed.repo && options.repo) {
    const explicit = await resolveRepo(options.repo, client.config.host);
    if (explicit.path !== repo.path) throw new Error('Merge request URL and --repo refer to different projects.');
  }
  const path = projectPath(repo.path);
  let iid = parsed.iid;
  if (!iid) {
    const branch = await currentBranch();
    if (!branch) throw new Error('A merge request number is required outside a branch.');
    const query = new URLSearchParams({ state: 'opened', source_branch: branch, scope: 'all' });
    const items = await client.paginate<MergeRequest>(`${path}/merge_requests?${query}`, 2);
    if (items.length !== 1) throw new Error(`${items.length ? 'Multiple open merge requests' : 'No open merge request'} found for branch ${branch}. Pass a number.`);
    iid = items[0].iid;
  }
  return { client, path: `${path}/merge_requests/${iid}`, iid };
}

function withRepo(command: Command): Command {
  return command.option('-R, --repo <group/project>', 'project path (including subgroups) or clone URL');
}

export function registerMrCommands(program: Command): void {
  const mr = program.command('pr').description('Manage GitLab merge requests');
  withRepo(mr.command('list').description('List merge requests'))
    .option('-s, --state <state>', 'open, closed, merged, or all', 'open')
    .option('-L, --limit <number>', 'maximum merge requests', '30').option('--json', 'output native GitLab JSON')
    .action(async (options: RepoOptions & { state: string; limit: string; json?: boolean }) => {
      const state = normalizeState(options.state);
      const limit = positiveInt(options.limit, 'limit');
      const { client, path } = await context(options.repo);
      const query = new URLSearchParams({ state, scope: 'all', order_by: 'updated_at', sort: 'desc' });
      const items = await client.paginate<MergeRequest>(`${path}/merge_requests?${query}`, limit);
      options.json ? printJson(items) : printMergeRequests(items);
    });

  withRepo(mr.command('view [number-or-url]').description('View a merge request (defaults to the current branch)'))
    .option('-c, --comments', 'include discussions').option('--json', 'output native GitLab JSON')
    .action(async (target: string | undefined, options: RepoOptions & { comments?: boolean; json?: boolean }) => {
      const { client, path } = await targetContext(target, options);
      const item = await client.requestJson<MergeRequest>(path);
      const discussions = options.comments ? await client.paginate<Discussion>(`${path}/discussions`) : undefined;
      if (options.json) printJson(discussions ? { ...item, discussions } : item);
      else { printMergeRequest(item); if (discussions) printDiscussions(discussions); }
    });

  withRepo(mr.command('edit [number-or-url]').description('Edit a merge request'))
    .option('-t, --title <title>', 'new title').option('-b, --body <body>', 'new description')
    .option('-B, --base <branch>', 'new target branch')
    .action(async (target: string | undefined, options: RepoOptions & { title?: string; body?: string; base?: string }) => {
      if (options.title === undefined && options.body === undefined && options.base === undefined) {
        throw new Error('At least one of --title, --body, or --base is required.');
      }
      const { client, path } = await targetContext(target, options);
      const item = await client.requestJson<MergeRequest>(path, { method: 'PUT',
        body: { title: options.title, description: options.body, target_branch: options.base } });
      console.log(`Updated merge request !${item.iid}: ${item.web_url}`);
    });

  withRepo(mr.command('create').description('Create a merge request'))
    .requiredOption('-t, --title <title>', 'merge request title').requiredOption('-b, --body <body>', 'description')
    .option('-H, --head <branch>', 'source branch (defaults to current branch)')
    .option('-B, --base <branch>', 'target branch (defaults to project default)')
    .option('-d, --draft', 'create as a draft')
    .action(async (options: RepoOptions & { title: string; body: string; head?: string; base?: string; draft?: boolean }) => {
      const { client, path } = await context(options.repo);
      const source = options.head ?? await currentBranch();
      if (!source) throw new Error('Source branch is required. Use --head.');
      const base = options.base ?? (await client.requestJson<{ default_branch?: string }>(path)).default_branch;
      if (!base) throw new Error('Target branch is required. Use --base.');
      const title = options.draft && !/^draft:/i.test(options.title) ? `Draft: ${options.title}` : options.title;
      const item = await client.requestJson<MergeRequest>(`${path}/merge_requests`, { method: 'POST',
        body: { title, description: options.body, source_branch: source, target_branch: base } });
      console.log(item.web_url);
    });

  withRepo(mr.command('diff [number-or-url]').description('Show a merge request diff'))
    .option('--stat', 'show per-file additions and deletions')
    .action(async (target: string | undefined, options: RepoOptions & { stat?: boolean }) => {
      const { client, path } = await targetContext(target, options);
      if (!options.stat) { console.log((await client.requestText(`${path}/raw_diffs`)).trimEnd()); return; }
      const diffs = await client.paginate<Diff>(`${path}/diffs?unidiff=true`);
      if (diffs.some((diff) => diff.too_large || diff.collapsed)) {
        throw new Error('GitLab omitted one or more file diffs. Cannot calculate complete statistics.');
      }
      printTable(['FILE', 'ADDED', 'DELETED'], diffs.map((diff) => {
        const lines = diff.diff.split('\n');
        return [diff.new_path, String(lines.filter((line) => line.startsWith('+')).length),
          String(lines.filter((line) => line.startsWith('-')).length)];
      }));
    });

  withRepo(mr.command('merge [number-or-url]').description('Merge using the project merge method'))
    .option('-m, --message <message>', 'merge commit message')
    .option('--strategy <strategy>', 'squash, or project (use the configured project merge method)', 'project')
    .option('--close-source-branch', 'delete source branch after merging')
    .action(async (target: string | undefined, options: RepoOptions & { message?: string; strategy: string; closeSourceBranch?: boolean }) => {
      if (!['project', 'squash'].includes(options.strategy)) {
        throw new Error('GitLab controls merge_commit and fast_forward in project settings. Use --strategy project or squash.');
      }
      const { client, path, iid } = await targetContext(target, options);
      const item = await client.requestJson<MergeRequest>(path);
      if (!item.sha) throw new Error('GitLab did not return a source SHA. Refusing an unguarded merge.');
      await client.requestJson(`${path}/merge`, { method: 'PUT', body: {
        sha: item.sha, merge_commit_message: options.message,
        squash: options.strategy === 'squash' ? true : undefined,
        should_remove_source_branch: options.closeSourceBranch,
      } });
      console.log(`Merged merge request !${iid}.`);
    });

  withRepo(mr.command('close <number-or-url>').description('Close a merge request'))
    .option('-c, --comment <body>', 'leave a closing comment')
    .action(async (target: string, options: RepoOptions & { comment?: string }) => {
      const { client, path, iid } = await targetContext(target, options);
      if (options.comment) await client.requestJson(`${path}/notes`, { method: 'POST', body: { body: options.comment } });
      await client.requestJson(path, { method: 'PUT', body: { state_event: 'close' } });
      console.log(`Closed merge request !${iid}.`);
    });

  withRepo(mr.command('comment [number-or-url]').description('Add a comment, inline discussion, or reply'))
    .requiredOption('-b, --body <body>', 'comment text').option('-f, --file <path>', 'file for an inline discussion')
    .option('-l, --line <number>', 'new-side line (same as --to)').option('--to <number>', 'new-side line')
    .option('--from <number>', 'old-side line, not a range start').option('--reply-to <note-id>', 'reply to a note in a discussion')
    .action(async (target: string | undefined, options: CommentOptions) => {
      const inline = validateInline(options);
      if (!options.body.trim()) throw new Error('Comment body cannot be empty.');
      const replyId = options.replyTo ? positiveInt(options.replyTo, 'reply-to') : undefined;
      const { client, path, iid } = await targetContext(target, options);
      if (replyId) {
        const discussions = await client.paginate<Discussion>(`${path}/discussions`);
        const discussion = discussions.find((item) => item.notes.some((note) => note.id === replyId));
        if (!discussion) throw new Error(`Comment #${replyId} was not found on this merge request.`);
        await client.requestJson(`${path}/discussions/${encodeURIComponent(discussion.id)}/notes`, { method: 'POST', body: { body: options.body } });
      } else if (inline) {
        const item = await client.requestJson<MergeRequest>(path);
        if (!item.diff_refs?.base_sha || !item.diff_refs.head_sha || !item.diff_refs.start_sha) {
          throw new Error('Merge request diff refs are not ready. Try again after GitLab processes the diff.');
        }
        const diffs = await client.paginate<Diff>(`${path}/diffs`);
        const diff = diffs.find((entry) => entry.new_path === options.file || entry.old_path === options.file);
        if (!diff) throw new Error(`File is not in this merge request diff: ${options.file}`);
        await client.requestJson(`${path}/discussions`, { method: 'POST', body: { body: options.body, position: {
          position_type: 'text', ...item.diff_refs, old_path: diff.old_path, new_path: diff.new_path,
          old_line: inline.oldLine, new_line: inline.newLine,
        } } });
      } else await client.requestJson(`${path}/notes`, { method: 'POST', body: { body: options.body } });
      console.log(`Commented on merge request !${iid}.`);
    });

  withRepo(mr.command('comments [number-or-url]').description('List discussions, preserving thread and inline context'))
    .option('--json', 'output native GitLab discussions JSON')
    .action(async (target: string | undefined, options: RepoOptions & { json?: boolean }) => {
      const { client, path } = await targetContext(target, options);
      const items = await client.paginate<Discussion>(`${path}/discussions`);
      options.json ? printJson(items) : printDiscussions(items);
    });

  withRepo(mr.command('review [number-or-url]').description('Approve a merge request or post a review comment'))
    .option('-a, --approve', 'approve the current source SHA').option('-c, --comment', 'post a review comment')
    .option('-r, --request-changes', 'unsupported by this integration; use a review comment instead')
    .option('-b, --body <body>', 'review comment text')
    .action(async (target: string | undefined, options: RepoOptions & { approve?: boolean; comment?: boolean; requestChanges?: boolean; body?: string }) => {
      if ([options.approve, options.comment, options.requestChanges].filter(Boolean).length !== 1) {
        throw new Error('Choose exactly one of --approve, --comment, or --request-changes.');
      }
      if (options.requestChanges) throw new Error('Requesting changes is not supported by this REST integration. Use an inline discussion or --comment --body instead.');
      if (options.comment && !options.body?.trim()) throw new Error('--body is required with --comment.');
      const { client, path, iid } = await targetContext(target, options);
      if (options.body) await client.requestJson(`${path}/notes`, { method: 'POST', body: { body: options.body } });
      if (options.approve) {
        const item = await client.requestJson<MergeRequest>(path);
        if (!item.sha) throw new Error('GitLab did not return a source SHA. Refusing an unguarded approval.');
        await client.requestJson(`${path}/approve`, { method: 'POST', body: { sha: item.sha } });
      }
      console.log(`${options.approve ? 'Approved' : 'Reviewed'} merge request !${iid}.`);
    });
}

export function validateInline(options: Pick<CommentOptions, 'file' | 'line' | 'to' | 'from' | 'replyTo'>): { newLine?: number; oldLine?: number } | undefined {
  const hasLines = options.line !== undefined || options.to !== undefined || options.from !== undefined;
  if (options.replyTo && (options.file || hasLines)) throw new Error('Cannot combine --reply-to with inline comment options.');
  if (!options.file) {
    if (hasLines) throw new Error('--file is required with --line, --to, or --from.');
    return undefined;
  }
  if (!hasLines) throw new Error('--line, --to, or --from is required with --file.');
  if (options.line !== undefined && options.to !== undefined && options.line !== options.to) throw new Error('--line and --to must refer to the same line.');
  const newLine = options.to ?? options.line;
  return { newLine: newLine === undefined ? undefined : positiveInt(newLine, 'line'),
    oldLine: options.from === undefined ? undefined : positiveInt(options.from, 'from') };
}
