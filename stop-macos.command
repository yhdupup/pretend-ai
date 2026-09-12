#!/bin/zsh
# 假装 AI —— macOS 停止（PRD §12.2 第 19 步）
#
# 正常情况下你不需要它：关掉启动时那个终端窗口就是停止。
# 这个脚本用于「窗口找不到了 / 用 --no-open 后台跑着 / 想干净地收一遍」的场合。
#
# 它只杀「自己能认出来的进程」：pid 文件里的 PID + 系统里复核命令行确实是我们起的那个服务。
# 认不出来就什么都不动（scripts/stop.mjs 里写的规矩）。

set -u

BOLD=$'\033[1m'; RED=$'\033[31m'; DIM=$'\033[2m'; OFF=$'\033[0m'

SELF="${0:A}"
ROOT="$(dirname "$SELF")"
[[ -f "$ROOT/runtime-manifest.json" ]] || ROOT="$(pwd -P)"
cd "$ROOT" || { print -u2 "${RED}进不去项目目录${OFF}"; exit 1; }

if [[ ! -f runtime-manifest.json ]]; then
  print -u2 "${RED}找不到 runtime-manifest.json，这里不是项目根目录${OFF}"
  exit 1
fi

NODE_VER="$(plutil -extract node.version raw runtime-manifest.json 2>/dev/null)"
NODE_TAG="$NODE_VER"
[[ "$NODE_TAG" == v* ]] || NODE_TAG="v$NODE_VER"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) TARGET="darwin-arm64" ;;
  *) TARGET="darwin-x64" ;;
esac
NODE_BIN=".runtime/node/$NODE_TAG/$TARGET/bin/node"

if [[ ! -x "$NODE_BIN" ]]; then
  print "${DIM}这个项目目录还没有装过运行环境，也没有在跑的服务，不用停。${OFF}"
  exit 0
fi

# 端口从 .env 读，保持和服务端一致（scripts/lib.mjs 里那套优先级）。
"$NODE_BIN" scripts/stop.mjs "$@"
CODE=$?
[[ $CODE -ne 0 ]] && print "${RED}停止流程没有完全成功（退出码 $CODE）${OFF} ${DIM}看上面的原因${OFF}"
exit $CODE
