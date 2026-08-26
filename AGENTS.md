# AGENTS.md

## 実装時のワークフロー

実装を行う際は `main` ブランチ上で直接ファイルを変更しないこと。必ず `git worktree` を作成してそこで作業すること。

### 手順

```sh
# 新しい worktree を作成（ブランチも同時に作成）
git worktree add -b <branch名> /tmp/<worktree名>

# 例: Medium 403 フォールバックの修正
git worktree add -b fix/medium-403-browser-fallback /tmp/fetch-proxy-fix-medium-403

# worktree 内で実装・コミット
git -C /tmp/<worktree名> add <file>
git -C /tmp/<worktree名> commit -m "fix: ..."

# push & PR作成
git -C /tmp/<worktree名> push -u origin <branch名>
gh pr create --head <branch名> --base main --title "..." --body "..."

# マージ後に worktree を削除
git worktree remove /tmp/<worktree名>
git branch -d <branch名>
git fetch --prune origin
```

### 注意

- `main` ワークツリーは常にクリーンに保つ。調査で一時的に変更した場合も、worktreeへコピー後は `git checkout -- <file>` で元に戻す。
- worktree のパスは `/tmp/<repo>-<topic>` を推奨（例: `/tmp/fetch-proxy-fix-medium-403`）。
- PR作成時は `gh pr create` を使用し、`--head` / `--base` を明示する。

## 複数セッションでのIssue並行処理（claimプロトコル）

`issue-claim-protocol` skill に従う。リポジトリ固有設定:

- CLAIM_SCOPE: `user:mpppk`
- CLAIM_LABEL: `in-progress`
- CLAIM_RESOURCES:
  - `shared:fetch-proxy-api`: `openapi.yaml`, `openapi.json`
  - `lockfile`: `bun.lock`, `skills-lock.json`
  - `ci-config`: `.github/workflows/**`

claim（Draft PR）は上記の worktree を作ってから確立する。worktree はブランチの置き場所であって、claim の単位は Issue 1件。

`shared:fetch-proxy-api` は HTTP 契約そのもの（OpenAPI 定義）だけを対象にする。呼び出し側は mpppk/share2cosense の `src/lib/fetchTitle.ts` / `src/lib/pageMeta.ts`。`src/index.ts` 全体はリソースに含めない — 含めるとこのリポジトリのほぼ全ての作業が排他対象になり並列度が落ちる。契約を変える変更は OpenAPI 定義にも必ず触れるので、そこだけ見れば足りる。
