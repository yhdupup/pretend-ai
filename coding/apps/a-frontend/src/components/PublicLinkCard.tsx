import { useState } from "react";
import type { LocalStatusResponse } from "../../../../src/shared/types";
import { copyDisabledReason, linkView } from "../public-status";
import { copyText } from "../clipboard";

interface Props {
  status: LocalStatusResponse | null;
  /** 会话自己的路径（/s/<id>），基址由隧道状态给。 */
  publicPath: string;
  /** 链接已经因为公网中断/换地址作废时，会话行上记的时间。 */
  linkInvalidatedAt?: string | null;
}

// 阶段3：要发给 B 的那条链接。
//
// 「能不能复制」只认服务端的探活结果，不看前端自己的猜测：
// PRD §26 阶段3 的验收口径是「复制按钮只在健康检查通过后可用」。
export default function PublicLinkCard({
  status,
  publicPath,
  linkInvalidatedAt,
}: Props) {
  // 记「复制的是哪条」而不是记一个布尔：换过域名之后不该继续显示「已复制」。
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const tunnel = status?.tunnel ?? null;
  const view = linkView(status, publicPath);
  const copied = copiedUrl === view.url;
  const blocked = linkInvalidatedAt
    ? "公网中断过，这条链接已经作废"
    : copyDisabledReason(tunnel);

  return (
    <section className="form-section link-card">
      <h2>B 的链接</h2>
      <p className="mono link-text" data-testid="public-link">
        {view.url}
      </p>
      <p className="hint">
        {view.sourceLabel}
        {view.reason ? ` · ${view.reason}` : ""}
      </p>
      <div className="status-actions">
        <button
          type="button"
          disabled={!!blocked}
          title={blocked ?? "复制给 B"}
          onClick={async () => {
            if (await copyText(view.url)) setCopiedUrl(view.url);
          }}
        >
          {copied && !blocked ? "已复制" : "复制链接"}
        </button>
        {/* 本机验不通时更要让 A 自己先点一下：这一步往往就是唯一能证明链接好坏的办法。 */}
        {(view.reachable || view.unverified) && !linkInvalidatedAt && (
          <a
            className="link-button"
            href={view.url}
            target="_blank"
            rel="noreferrer"
          >
            {view.reachable ? "自己打开看看" : "先自己点开试试"}
          </a>
        )}
      </div>
      {linkInvalidatedAt && (
        <p className="error">
          公网中断过，这条链接已经作废（
          {new Date(linkInvalidatedAt).toLocaleTimeString()}）。B
          再打开会看到「这个链接已经不能用」。
        </p>
      )}
    </section>
  );
}
