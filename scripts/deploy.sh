#!/usr/bin/env bash
# 一键构建并发布到 GitHub Pages（gh-pages 分支）
# 用法： ./scripts/deploy.sh            # 默认仓库 kenzhao11/kanju-clone
#        REPO=user/repo ./scripts/deploy.sh
set -euo pipefail

REPO="${REPO:-kenzhao11/kanju-clone}"
NAME="${REPO%%/*}"

cd "$(dirname "$0")/.."

SUB_PATH="/${REPO##*/}/"
echo "==> 构建（base=$SUB_PATH）"
BASE_PATH="$SUB_PATH" npx vite build

echo "==> 发布 dist/ 到 gh-pages"
TMP="$(mktemp -d)"
cp -r dist/. "$TMP/"
touch "$TMP/.nojekyll"

cd "$TMP"
git init -q
git config user.name "$NAME"
git config user.email "$NAME@users.noreply.github.com"
git checkout -q -b gh-pages
git add -A
git commit -q -m "deploy: $(date '+%Y-%m-%d %H:%M:%S')"
git remote add origin "https://github.com/${REPO}.git"

if command -v gh >/dev/null 2>&1; then
  # 用 gh 的凭据推送，避免手动输入 token
  CRED='!f() { echo "username='"$NAME"'"; echo "password=$(gh auth token)"; }; f'
else
  CRED=''
fi

# 先取一次远端分支，--force-with-lease 才有可比较的基准引用
git -c credential.helper="$CRED" fetch -q origin gh-pages 2>/dev/null || true
git -c credential.helper="$CRED" push --force-with-lease origin gh-pages

rm -rf "$TMP"
echo "==> 完成： https://${NAME}.github.io/${REPO##*/}/"
