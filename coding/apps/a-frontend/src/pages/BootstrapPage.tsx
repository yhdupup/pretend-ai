import { useEffect, useState } from "react";
import { bootstrap } from "../api";

// 启动器把 http://<a-frontend origin>/bootstrap/<token> 交给浏览器做首次导航。
// 本页面加载后立即发起兑换请求；成功后由父组件用 history.replaceState 把 token 从地址栏清掉。

interface Props {
  token: string;
  onDone: () => void;
}

export default function BootstrapPage({ token, onDone }: Props) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    bootstrap(token)
      .then(() => {
        if (!cancelled) onDone();
      })
      .catch(() => {
        if (!cancelled) setError("令牌无效或已被使用，请重新启动本机控制端。");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (error) {
    return <div className="page bootstrap-page error">{error}</div>;
  }
  return <div className="page bootstrap-page">正在建立本机控制连接…</div>;
}
