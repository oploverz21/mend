# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/oploverz21/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/oploverz21/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a tiny patch applier: one CLI that reads a patch — a unified diff, SEARCH/REPLACE blocks, a V4A patch, or JSON edit commands — from a file or stdin, and applies it to the files of the current directory. A patch is applied all at once or not at all: if any edit fails, no file on disk changes.

Old lines are matched at three tiers — exact, then ignoring trailing whitespace, then ignoring leading and trailing whitespace — and context lines are always written back as the file's own lines, so a patch survives the usual whitespace drift. Unified hunks are matched at the occurrence nearest to where the hunk header says they belong; SEARCH/REPLACE blocks must match exactly once; V4A chunks walk a cursor through the file with `@@` anchors. Files keep their own line break (CRLF or LF) and their final line break, unless a hunk says otherwise.

Practice score 1000/1000 on the kit's 100 public practice checks.

## Run it

```sh
node main.ts change.diff
```

`node main.ts [options] [PATCH]` — PATCH defaults to stdin, `-` also means stdin. `--check` validates and reports without writing anything, `--strict` only accepts exact matches, `--format=` names the format (`json`, `unified`, `search-replace`, `v4a`, `auto`). Exit codes: 0 applied (or validated), 1 an edit failed, 2 usage / no patch / unreadable patch. Node 22, standard library only. `check.ts` beside it runs the kit's practice set (`node check.ts <practice.json>`) and `runner.ts` runs the trial.

---

<sub>Entered on [make.fun](https://make.fun/?ref=1wb47vye&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
