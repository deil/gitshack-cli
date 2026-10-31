import type { MergeRequest, Project, Discussion } from './gitlab.js';

export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => row[i].length)));
  console.log(headers.map((header, i) => header.padEnd(widths[i])).join('  '));
  for (const row of rows) console.log(row.map((cell, i) => cell.padEnd(widths[i])).join('  '));
}

export function printMergeRequests(items: MergeRequest[]): void {
  if (!items.length) { console.log('No merge requests found.'); return; }
  printTable(['ID', 'STATE', 'TITLE', 'BRANCH', 'UPDATED'], items.map((mr) => [
    `!${mr.iid}`, mr.state, mr.title, mr.source_branch, mr.updated_at ?? '',
  ]));
}

export function printMergeRequest(mr: MergeRequest): void {
  for (const [key, value] of Object.entries({ title: mr.title, state: mr.state, author: mr.author?.username,
    source: mr.source_branch, target: mr.target_branch, url: mr.web_url, created: mr.created_at, updated: mr.updated_at })) {
    console.log(`${key}:\t${value ?? ''}`);
  }
  if (mr.description) console.log(`\n${mr.description}`);
}

export function printProjects(items: Project[]): void {
  if (!items.length) { console.log('No repositories found.'); return; }
  printTable(['NAME', 'BRANCH', 'VISIBILITY', 'UPDATED'], items.map((project) => [
    project.path_with_namespace, project.default_branch ?? '', project.visibility, project.last_activity_at ?? '',
  ]));
}

export function printDiscussions(items: Discussion[]): void {
  if (!items.length) { console.log('No comments found.'); return; }
  for (const discussion of items) {
    for (const note of discussion.notes) {
      console.log(`#${note.id} ${note.author?.username ?? 'unknown'} [discussion ${discussion.id}]${note.system ? ' [system]' : ''}:`);
      if (note.position) console.log(`  ${JSON.stringify(note.position)}`);
      console.log(note.body);
    }
  }
}
