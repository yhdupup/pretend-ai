// 复制到剪贴板。navigator.clipboard 只在安全上下文里有（https 或 http://127.0.0.1），
// A 工作台是本机 http，所以两条路都得留：失败就退回选中文本，让 A 自己按 Cmd+C。
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 走兜底 */
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
