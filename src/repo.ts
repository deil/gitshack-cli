import { Command } from 'commander';
import { requireConfig } from './config.js';
import { GitLabClient, ApiError, projectPath, type Project, type User } from './gitlab.js';
import { resolveRepo } from './git.js';
import { printProjects } from './format.js';
import { openBrowser, positiveInt, printJson, selectFields } from './util.js';

export function registerRepoCommands(program: Command): void {
  const repo = program.command('repo').description('Work with GitLab repositories');
  repo.command('list [owner]').alias('ls').description('List accessible repositories, or repositories in a group or user namespace')
    .option('-L, --limit <number>', 'maximum repositories', '30')
    .option('--visibility <visibility>', 'public, internal, or private')
    .option('--json [fields]', 'output native GitLab JSON, optionally selecting fields')
    .action(async (owner: string | undefined, options: { limit: string; visibility?: string; json?: string | boolean }) => {
      const client = new GitLabClient(await requireConfig());
      const limit = positiveInt(options.limit, 'limit');
      if (options.visibility && !['public', 'internal', 'private'].includes(options.visibility)) {
        throw new Error('Visibility must be public, internal, or private.');
      }
      const query = new URLSearchParams({ order_by: 'last_activity_at', sort: 'desc' });
      if (options.visibility) query.set('visibility', options.visibility);
      let path = '/projects';
      if (owner) {
        const group = `/groups/${encodeURIComponent(owner)}`;
        try {
          await client.requestJson(group);
          path = `${group}/projects`;
          query.set('include_subgroups', 'true');
          query.set('with_shared', 'false');
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error;
          const users = await client.requestJson<User[]>(`/users?username=${encodeURIComponent(owner)}`);
          const user = users.find((item) => item.username.toLowerCase() === owner.toLowerCase());
          if (!user) throw new Error(`GitLab group or user not found: ${owner}`);
          path = `/users/${user.id}/projects`;
        }
      } else query.set('membership', 'true');
      const items = await client.paginate<Project>(`${path}?${query}`, limit);
      options.json ? printJson(selectFields(items, options.json)) : printProjects(items);
    });
  repo.command('view [repository]').description('Display repository details and README')
    .option('-b, --branch <branch>', 'README branch')
    .option('--json [fields]', 'output native GitLab project JSON')
    .option('-w, --web', 'open repository in the browser')
    .action(async (input: string | undefined, options: { branch?: string; json?: string | boolean; web?: boolean }) => {
      const client = new GitLabClient(await requireConfig());
      const ref = await resolveRepo(input, client.config.host);
      const path = projectPath(ref.path);
      const project = await client.requestJson<Project>(path);
      if (options.web) { await openBrowser(project.web_url); return; }
      if (options.json) { printJson(selectFields(project, options.json)); return; }
      console.log(`name:\t${project.path_with_namespace}\ndescription:\t${project.description ?? ''}\nvisibility:\t${project.visibility}\nmain branch:\t${project.default_branch ?? ''}\nurl:\t${project.web_url}`);
      const branch = options.branch ?? project.default_branch;
      if (!branch) return;
      let candidates = ['README.md', 'README.rst', 'README.txt', 'README'];
      if (project.readme_url) {
        const marker = '/-/blob/';
        const tail = project.readme_url.split(marker)[1];
        if (tail?.startsWith(`${project.default_branch}/`)) candidates.unshift(tail.slice(project.default_branch!.length + 1));
      }
      for (const file of [...new Set(candidates)]) {
        try {
          const readme = await client.requestText(`${path}/repository/files/${encodeURIComponent(file)}/raw?ref=${encodeURIComponent(branch)}`);
          console.log(`\n${readme}`); return;
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error;
        }
      }
    });
}
