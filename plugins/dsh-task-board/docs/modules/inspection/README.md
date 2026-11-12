# dsh-task-board-inspection

English | [中文](README.zh.md)

Read-only workspace inspection with evidence-backed backlog recommendations for the DSH task board.

## What it does

- Reuses DSH workspaces with explicit goals, root directories, authorized relative paths, model routes and inspection switches.
- Runs manual inspections; daily inspections use an optional board Cron adapter and skip missed occurrences.
- Validates structured model output, including zero recommendations; each candidate carries evidence, rationale, scope and acceptance criteria.
- Persists candidates in its own domain before atomic board upserts into backlog/proposed; retries reuse durable candidates and source keys.

## Install

Requires the task-board service, DSH workspaceRegistry, storageDomain and a callable LLM service. This Cordis bundle does not modify DSH source.

```sh
dsh plugin --profile <name> add link:/absolute/path/to/packages/dsh-task-board-inspection
```

Installation and profile changes are performed only with explicit user authorization; follow the installation result when the host requires reload or restart.

## Config

Click Configure inspection in the task board's Project inspection settings to add or edit rules in a dialog. Closing preserves the current view; cancelling discards unsaved edits. Select an existing workspace and enter its goal, authorized root, relative paths and provider/model. Git information, session summaries and inspection history are collapsed by default; enabling daily inspection reveals Cron and time zone fields. Saving closes the dialog. Save before running manually. New rules authorize neither scanning nor Cron; the bundle defaults to an empty rules array.

```yaml
enabled: true
rules:
  - id: project-review
    workspaceId: existing-dsh-workspace-id
    enabled: false
    root: /absolute/project/path
    goal: 完成已约定目标，检查实际进度与验收缺口
    revision: 1
    paths:
      - README.md
      - docs/progress
    model: provider/model
    daily: false
    cron: '0 9 * * *'
    timeZone: Asia/Shanghai
    maxRecommendations: 3
    includeGit: false
```

Daily inspection requires inspectionSchedule.register on the board. Without it the daily toggle is disabled and the host reports schedule-adapter-unavailable. The extension never creates a second native schedule. Rule identity, goal revision and the actual occurrence determine a scheduled batch; manual runs use their own random identity.

Each project permits at most 3 recommendations; each batch scans at most 5 projects and creates at most 5 recommendations. File limits are 24 files, 256 visited nodes, 16 KiB per file and 96000 bytes of total file text; each project has 90 seconds, and model output is limited to 4096 tokens and 16000 characters. Only the current call's returned token usage is recorded. Missing usage stays unknown; costs and inspection usage are never inferred from global board totals.

## Security model

- Only explicitly enabled rules may scan. The realpath root must remain inside the chosen workspace, and authorized paths cannot escape. Symlinks are not followed; file opening uses O_NOFOLLOW and verifies inode identity.
- Hidden directories, dependencies, build output, common credential files, large files, binaries and text matching private-key or credential patterns are excluded. Filtering is an additional defense; keep authorization narrow.
- No dependency installation, repository scripts or general Agent tools are used. Optional Git evidence contains recent commit subjects and staged paths only; fixed commands disable hooks, fsmonitor, external diff, textconv, lazy fetch and inherited Git configuration variables. Unstaged differences are not read.
- The model receives only the goal, bounded evidence and a limited historical card summary. It has no tools or ledger writes. The Host validates evidence references before calling atomic recommendation upsert. Every recommendation requires human board acceptance before execution.

## Known limitations

A missing atomic recommendation API refuses the run rather than falling back to ordinary creation and movement. The batch domain and board ledger are separate transactions. Durable candidates and incremental commits support retry, while source-key deduplication remains the board's authority across active and archived cards.

Optional sessionIds explicitly selects at most 5 sessions, reading only settled summaries already recorded by this board in the same execution workspace; arbitrary DSH session history is never traversed. Remote GitHub, store analytics, unstaged changes and external worktree Git metadata are outside this collector's scope. Coverage reports distinguish not requested, collected and unavailable, and never claim uncovered evidence was checked.

Recommendations expire after 24 hours. Acceptance rechecks the goal revision and full rule fingerprint. Rule or workspace-path changes during analysis reject old candidates. Partial-commit retries reuse durable candidates and stay pinned to the rule's workspace. Reinspection may refresh unaccepted evidence and restricted input while preserving human snooze decisions.

Automated validation uses temporary directories, model streams and service fixtures. It does not establish actual user-project, real model-provider, real scheduled-occurrence or production GUI acceptance.
