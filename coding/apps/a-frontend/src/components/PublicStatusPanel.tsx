import { useState } from "react";
import type { LocalStatusResponse } from "../../../../src/shared/types";
import {
  STATUS_TEXT,
  actionStates,
  installHint,
  shouldShowBaseUrl,
  statusDetail,
} from "../public-status";
import { copyText } from "../clipboard";

interface Props {
  status: LocalStatusResponse | null;
  busy: boolean;
  error?: string | null;
  act: (action: "start" | "stop" | "reconnect" | "recheck") => Promise<void>;
}

// 阶段3：公网通道控制。作者 2026-09-12 定下的口径：这一块**只留操作**——
// 平时就是一行状态 + 「停止」「换一条链接」两个按钮；政策数字、地址、重连计数
// 都不常态展示，只在出事的那一态出现。能发给 B 的链接永远只从会话卡片复制。
export default function PublicStatusPanel({ status, busy, error, act }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const tunnel = status?.tunnel ?? null;
  const state = tunnel?.status ?? "STOPPED";
  const { canStart, canStop, canSwap, canRecheck } = actionStates(tunnel);
  // 地址只在「本机还没验通」时亮出来（那时 A 需要拿手机流量自查，见 shouldShowBaseUrl）
  const showBase = shouldShowBaseUrl(tunnel);
  const shownBase = tunnel?.publicBaseUrl ?? tunnel?.pendingBaseUrl ?? "";
  const hint = installHint(tunnel);
  const detail = statusDetail(tunnel);

  return (
    <section className="form-section public-status compact" data-status={state}>
      <div className="status-actions">
        <span className={`status-dot status-${state}`}>
          {tunnel ? STATUS_TEXT[state] : "正在读取状态…"}
        </span>
        {canStart && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act("start")}
          >
            {state === "UNAVAILABLE" ? "重试" : "开启公网链接"}
          </button>
        )}
        {canStop && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act("stop")}
          >
            停止
          </button>
        )}
        {canSwap && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act("reconnect")}
          >
            换一条链接
          </button>
        )}
        {/* 本机解析不通时地址常常是好的（浏览器/手机能打开），先重验比重换域名代价小。 */}
        {canRecheck && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act("recheck")}
          >
            再验一次
          </button>
        )}
        {copied && <span className="hint">{copied}</span>}
      </div>

      {state !== "ONLINE" && detail && (
        <p className="hint">{detail}</p>
      )}

      {showBase && (
        <p className="base-url mono">
          <span className="base-label">
            通道地址，不是要发给 B 的链接 —— 发给别人请用会话卡片上的「复制链接」
          </span>
          <br />
          {shownBase}
          <a
            className="link-button"
            href={shownBase}
            target="_blank"
            rel="noreferrer"
          >
            自己打开看看
          </a>
          <span className="sub">　← 这条还没验证过，先拿手机流量点开试</span>
        </p>
      )}

      {tunnel?.error && <p className="error">{tunnel.error}</p>}
      {error && <p className="error">{error}</p>}

      {hint && (
        <p className="install">
          在这台电脑上执行一次：
          <code className="mono">{hint}</code>
          <button
            type="button"
            className="link-button"
            onClick={async () => {
              if (await copyText(hint)) setCopied("命令已复制");
            }}
          >
            复制命令
          </button>
        </p>
      )}

    </section>
  );
}
