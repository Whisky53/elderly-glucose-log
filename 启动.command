#!/bin/zsh
# 双击启动本地血糖记录应用（开发模式，端口 5175）
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "首次运行：安装依赖中…"
  pnpm install || { echo "pnpm 不可用，请先安装 Node.js 22 与 pnpm"; exit 1; }
fi
open "http://localhost:5175/"
exec pnpm --filter web dev
