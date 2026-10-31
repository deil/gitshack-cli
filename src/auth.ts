import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { configPath, deleteConfig, normalizeHost, requireConfig, writeConfig } from './config.js';
import { GitLabClient, type User } from './gitlab.js';

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Manage GitLab authentication');
  auth.command('login').description('Log in with a GitLab personal access token')
    .option('--hostname <host>', 'self-hosted GitLab instance URL (or set GITLAB_HOST)')
    .option('--with-token', 'read token from standard input')
    .action(async (options: { hostname?: string; withToken?: boolean }) => {
      const host = normalizeHost(options.hostname ?? process.env.GITLAB_HOST ?? '');
      let token: string;
      if (options.withToken) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
        token = Buffer.concat(chunks).toString('utf8').trim();
      } else {
        token = await askToken();
      }
      if (!token) throw new Error('A GitLab personal access token is required.');
      const config = { host, token };
      const user = await new GitLabClient(config).requestJson<User>('/user');
      await writeConfig(config);
      console.log(`Logged in to ${host} as ${user.username}.`);
      console.log(`Credentials saved to ${configPath()}.`);
    });
  auth.command('logout').description('Remove saved GitLab credentials').action(async () => {
    await deleteConfig();
    console.log('Saved credentials removed. GITLAB_TOKEN, if set, still applies.');
  });
  auth.command('status').description('Verify GitLab authentication').action(async () => {
    const config = await requireConfig();
    const user = await new GitLabClient(config).requestJson<User>('/user');
    console.log(`${config.host}: logged in as ${user.username}`);
    console.log(`config: ${configPath()}`);
  });
}

async function askToken(): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Use --with-token to read a token from standard input.');
  // Suppress terminal echo while reading credentials, including during readline redraws.
  const { Writable } = await import('node:stream');
  process.stdout.write('GitLab personal access token: ');
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try { return (await rl.question('')).trim(); }
  finally { rl.close(); process.stdout.write('\n'); }
}
