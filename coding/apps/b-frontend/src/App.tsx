import { useEffect, useState } from "react";
import SessionPage from "./pages/SessionPage";

// B 端极简路由：只有一个真实路由 /s/:id（对应 A 端创建会话时返回的 publicPath）。

function useCurrentPath(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  return path;
}

export default function App() {
  const path = useCurrentPath();
  const match = path.match(/^\/s\/([^/]+)$/);

  if (match) {
    const sessionId = match[1] as string;
    return <SessionPage sessionId={sessionId} />;
  }

  return (
    <div className="page not-found-page">
      <p>此链接无效，请确认地址是否正确。</p>
    </div>
  );
}
