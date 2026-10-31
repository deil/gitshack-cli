# gitshack-cli

A small CLI for **self-hosted GitLab**, built with TypeScript, Node.js, and Commander. Manage authentication, repositories, and merge requests from your terminal.

The executable is `gs-gitlab`. Future provider-specific executables can use `gs-github`, `gs-bb`, and `gs-ado`; those integrations are not implemented yet.

## Install

Requires Node.js 20 or newer and Git for remote and branch inference.

```bash
npm install
npm run build
npm link
gs-gitlab --help
```

## Authentication

Create a personal access token on your own GitLab instance. Use `read_api` for read-only access or `api` for creating, commenting, approving, and merging merge requests. Your project permissions and instance policies still apply.

```bash
gs-gitlab auth login --hostname https://gitlab.example.com
# Or read the token from stdin without putting it in command-line arguments:
printf '%s' "$TOKEN" | gs-gitlab auth login --hostname https://gitlab.example.com --with-token
gs-gitlab auth status
gs-gitlab auth logout
```

Login verifies the token with `/api/v4/user` before saving it. Interactive token entry is hidden. Credentials are stored as plaintext with file permissions `0600` in `${XDG_CONFIG_HOME:-~/.config}/gitshack/config.json`. One instance is saved at a time.

For automation, environment variables override saved settings:

```bash
export GITLAB_HOST=https://gitlab.example.com
export GITLAB_TOKEN='<personal-access-token>'
gs-gitlab repo list
```

There is no default instance and GitLab.com is not supported. Changing `GITLAB_HOST` does not reuse a different instance's stored token. Logout removes saved credentials, not environment variables. HTTPS is recommended; explicitly configured HTTP URLs are supported for local or private installations, but transmit tokens without encryption. Relative URL installations such as `https://example.com/gitlab` are supported. Use your instance's canonical URL because authenticated redirects are refused.

## Repositories

Project references accept `group/project`, nested groups such as `group/team/project`, and HTTPS or SSH clone URLs. Commands without an explicit project try `origin`, then other Git remotes matching the configured instance. A remote or merge request URL never changes which instance receives your token.

```bash
gs-gitlab repo list                       # projects you belong to
gs-gitlab repo list engineering/platform  # group and subgroup projects
gs-gitlab repo list username              # user's owned projects
gs-gitlab repo list --visibility private --limit 50
gs-gitlab repo list --json path_with_namespace,visibility
gs-gitlab repo view group/team/project
gs-gitlab repo view --branch main
gs-gitlab repo view group/team/project --json
gs-gitlab repo view --web
```

Group names are tried before usernames. `--json` returns native GitLab project objects; normal repository view also displays a README when available.

## Merge Requests

Use `pr` to manage GitLab merge requests. Numbers are project-local merge request IIDs, not global IDs. Quote numbers prefixed with `!` in interactive shells.

```bash
gs-gitlab pr list -R group/team/project
gs-gitlab pr list --state all --limit 50 --json
gs-gitlab pr view 42
gs-gitlab pr view https://gitlab.example.com/group/team/project/-/merge_requests/42
gs-gitlab pr view 42 --comments --json
gs-gitlab pr edit 42 --title 'Updated title' --body 'Updated description' --base main
gs-gitlab pr create --title 'Add export' --body 'Adds CSV export' --head feature/export --base main
gs-gitlab pr create --title 'Work in progress' --body 'Details' --draft
gs-gitlab pr diff 42
gs-gitlab pr diff 42 --stat
gs-gitlab pr comment 42 --body 'Looks good'
gs-gitlab pr comment 42 --body 'Check this line' --file src/index.ts --line 20
gs-gitlab pr comment 42 --body 'Old-side comment' --file src/index.ts --from 18
gs-gitlab pr comment 42 --body 'Fixed' --reply-to 123
gs-gitlab pr comments 42 --json
gs-gitlab pr review 42 --approve
gs-gitlab pr review 42 --comment --body 'Please update the tests'
gs-gitlab pr merge 42 --strategy squash --close-source-branch
gs-gitlab pr close 42 --comment 'Superseded'
```

Omit the number to select the single open merge request whose source branch matches your current branch. Creation defaults to the current branch and the project's default target branch. `-R` selects the project; cross-project fork creation is not exposed.

### GitLab-Specific Behavior

- Discussions preserve native thread IDs, notes, system messages, and inline positions in JSON. `--reply-to` takes a numeric note ID, finds its discussion, and posts a reply there. Inline comments use the current diff refs and handle renamed paths. `--to` and `--from` select new-side and old-side lines, not a line range.
- Approvals use GitLab's approval API, subject to instance version, eligibility, and policy. Merge and approval requests include the source SHA to guard against concurrent pushes.
- `--request-changes` fails explicitly instead of pretending a comment blocks merging. This REST integration does not implement GitLab's blocking change-request workflow.
- Merge method is controlled by project settings. `--strategy project` (default) leaves those settings in charge; `--strategy squash` requests squashing. Per-request `merge_commit` and `fast_forward` are rejected rather than silently changing project settings.
- Diff output uses GitLab's raw diffs endpoint; `--stat` uses paginated file diffs. Server-side diff limits still apply. Statistics fail when GitLab marks a diff as collapsed or too large. Binary files have no textual line counts.
- This CLI does not expose pipelines, issues, project administration, OAuth, or browser login.

## Development

```bash
npm run dev -- --help
npm run typecheck
npm test
npm run build
```

Tests mock the GitLab API and isolate config storage. They do not require live credentials or change repositories on your instance.
