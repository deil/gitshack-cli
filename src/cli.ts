import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { registerAuthCommands } from './auth.js';
import { registerRepoCommands } from './repo.js';
import { registerMrCommands } from './mr.js';

export function createProgram(): Command {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  const program = new Command().name('gs-gitlab').description('Self-hosted GitLab CLI for repositories and merge requests').version(version);
  registerAuthCommands(program);
  registerRepoCommands(program);
  registerMrCommands(program);
  return program;
}

export async function runCli(program: Command, argv = process.argv): Promise<void> {
  try { await program.parseAsync(argv); }
  catch (error) {
    console.error(`${program.name()}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
