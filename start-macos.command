#!/bin/zsh
# 假装 AI —— macOS 启动（PRD §12.2 第 1~6 步）
#
# 这个文件是「引导层」：它自己不能依赖 Node，因为第一次双击时系统里可能一个 Node 都没有。
# 所以它只做四件必须留在 shell 里的事，其余全部交给 scripts/*.mjs（可测试的准备层）：
#   1. 定位项目根（.command 被拷到桌面/下载目录也不会认错家）
#   2. Gatekeeper 提示（不签证书就要教用户怎么办，PRD §13.3）
#   3. 没有项目专用 Node 时，用系统自带的 curl + shasum + tar 下一次，SHA-256 对不上就绝不解压执行
#   4. 之后一切交给 node scripts/bootstrap.mjs
#
# 关掉这个终端窗口 = 停止服务（前台常驻，会话会被服务端正常结束，PRD §12.2 第 19 步）。
# 不做后台守护、不改 PATH、不装任何东西到项目目录之外（PRD §4「不留痕」）。

set -u

BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; OFF=$'\033[0m'

fail() {
  print -u2 "${RED}启动失败：$1${OFF}"
  [[ -n "${2:-}" ]] && print -u2 "${DIM}怎么办：$2${OFF}"
  print ""
  print "这个窗口可以直接关掉。需要帮助：打开项目文件夹里的 docs/启动失败手动处理.md"
  exit 1
}

# 1) 定位项目根：允许 .command 被软链/拷贝到别处，只有这份文件被移动才回落到 pwd -P。
SELF="${0:A}"
ROOT="$(dirname "$SELF")"
if [[ ! -f "$ROOT/runtime-manifest.json" || ! -d "$ROOT/coding" ]]; then
  ROOT="$(pwd -P)"
fi
[[ -f "$ROOT/runtime-manifest.json" ]] || fail "找不到 runtime-manifest.json" "你拷贝的是零散文件，不是完整项目目录"
cd "$ROOT" || fail "进不去项目目录 $ROOT" "把整个项目目录放到没有中文和空格的路径下再试"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) TARGET="darwin-arm64" ;;
  x86_64) TARGET="darwin-x64" ;;
  *) fail "这台 Mac 的芯片架构是 $ARCH，本项目没为它把过关" "支持 Apple 芯片(arm64) 与 Intel(x86_64)" ;;
esac

# 2) 首次运行的 Gatekeeper 提示。我们不签证书（个人项目，$99/年），所以 macOS 一定会拦一次。
if [[ ! -f .runtime/launched ]]; then
  print "${BOLD}第一次在这个 Mac 上运行${OFF}"
  print "${DIM}如果被提示「无法打开，来自身份不明的开发者」：在项目文件夹上${OFF}"
  print "${DIM}点右键 → 打开 → 再点打开。之后就不会再问了。${OFF}"
  print ""
fi

# 3) 读清单里的版本与校验值。plutil 是 macOS 自带的，不要求你装 jq / brew / node。
command -v plutil >/dev/null 2>&1 || fail "系统里没有 plutil" "这不是正常的 macOS，检查一下系统完整性"
NODE_VER="$(plutil -extract node.version raw runtime-manifest.json 2>/dev/null)"
[[ -n "$NODE_VER" ]] || fail "runtime-manifest.json 里缺 node.version" "重新获取完整项目目录"
NODE_SHA="$(plutil -extract "node.targets.$TARGET.sha256" raw runtime-manifest.json 2>/dev/null)"
if [[ -z "$NODE_SHA" || "$NODE_SHA" == "(null)" ]]; then
  fail "清单里没有 $TARGET 的校验值，这一版项目没为这台机器把过关" \
       "不要在本地改清单凑数；找作者用 coding/scripts/gen-runtime-manifest.mjs 补"
fi
# 清单里允许写 v24.18.1 或 24.18.1，这里统一成带 v 的形式（nodejs.org 的路径要带 v）
NODE_TAG="$NODE_VER"
[[ "$NODE_TAG" == v* ]] || NODE_TAG="v$NODE_VER"
PKG="node-$NODE_TAG-$TARGET.tar.gz"
DEST=".runtime/node/$NODE_TAG/$TARGET"
NODE_BIN="$DEST/bin/node"

# 4) 已经装好了就直接复用；否则下载 → 校验 → 才解压（校验不过绝不落进 .runtime）
if [[ ! -x "$NODE_BIN" ]]; then
  print "${BOLD}[下载 Node 运行环境]${OFF} ${DIM}$PKG${OFF}"
  mkdir -p .runtime/download "$DEST"
  TMP=".runtime/download/$PKG.part"
  BASE="${AIWINDOW_NODE_BASE:-https://nodejs.org/dist}"
  BASE="${BASE%/}"
  # 镜像只能换主机，不能换校验值：下面仍然用官方清单里的 SHA-256。
  command -v curl >/dev/null 2>&1 || fail "系统里没有 curl" "这不太可能是正常的 macOS"
  curl -fL --retry 3 --connect-timeout 15 -o "$TMP" "$BASE/$NODE_TAG/$PKG" \
    || fail "下载失败：$BASE/$NODE_TAG/$PKG" "检查网络；换网络后重新双击；要换镜像就设 AIWINDOW_NODE_BASE"
  ACTUAL="$(shasum -a 256 "$TMP" 2>/dev/null | cut -d' ' -f1)"
  if [[ "${ACTUAL:l}" != "${NODE_SHA:l}" ]]; then
    rm -f "$TMP"
    fail "下载的 Node 与清单校验值不一致，已删除，不会解压执行" "多半是网络被劫持；换网络重试"
  fi
  print "${GREEN}校验通过${OFF} ${DIM}sha256 ${NODE_SHA:0:12}…${OFF}"
  tar -xf "$TMP" -C "$DEST" --strip-components 1 || { rm -f "$TMP"; fail "解压失败" "重新双击试一次"; }
  rm -f "$TMP"
  chmod +x "$NODE_BIN" 2>/dev/null
  : > .runtime/launched
fi

[[ -x "$NODE_BIN" ]] || fail "运行环境不可用：$NODE_BIN" "删掉 .runtime 目录再重新双击"

# 5) 后面全部交给准备层。stdout 保持 inherit：npm 的进度、条款确认都要能直接看到。
print "${BOLD}[准备项目]${OFF} ${DIM}第一次会装依赖并构建，需要几分钟${OFF}"
"$NODE_BIN" scripts/bootstrap.mjs "$@"
CODE=$?

print ""
if [[ $CODE -eq 0 ]]; then
  print "${GREEN}已停止${OFF} 关闭这个窗口就彻底退出了；原公网链接与工作会话同时失效。"
else
  print "${RED}退出码 $CODE${OFF}  上面最后几行就是原因。日志在 logs/ 目录里。"
fi
exit $CODE
