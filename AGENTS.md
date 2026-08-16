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
