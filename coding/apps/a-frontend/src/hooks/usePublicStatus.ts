import { useCallback, useEffect, useRef, useState } from "react";
import { getStatus, tunnelAction } from "../api";
import { statusFetchErrorText } from "../public-status";
import type { LocalStatusResponse } from "../../../../src/shared/types";

export type TunnelAction = "start" | "stop" | "reconnect" | "recheck";

// A 页面看到的公网通道状态：进来先问一次，之后每 2 秒问一次；
// 点了按钮立刻再问一次（不等下一个轮询周期，否则用户以为没反应）。
const STATUS_POLL_MS = 2000;

export interface PublicStatusApi {
  status: LocalStatusResponse | null;
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  act: (action: TunnelAction) => Promise<void>;
}

export function usePublicStatus(): PublicStatusApi {
  const [status, setStatus] = useState<LocalStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await getStatus();
      if (!mounted.current) return;
      setStatus(next);
      setError(null);
    } catch (err) {
      // 读不到状态不打断页面，下一轮轮询自然补上；但要把「会话失效」和「服务没起来」分开说
      if (mounted.current) setError(statusFetchErrorText(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = useCallback(async (action: TunnelAction) => {
    setBusy(true);
    try {
      const next = await tunnelAction(action);
      if (mounted.current) setStatus(next);
    } catch {
      if (mounted.current) setError("操作没成功，可以再点一次");
    } finally {
      setBusy(false);
    }
  }, []);

  return { status, busy, error, refresh, act };
}
