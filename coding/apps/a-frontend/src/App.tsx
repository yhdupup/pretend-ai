import { useCallback, useEffect, useState } from "react";
import BootstrapPage from "./pages/BootstrapPage";
import HomePage from "./pages/HomePage";
import SessionPage from "./pages/SessionPage";

// 极简手写路由：阶段一路由数量少（bootstrap / 首页 / 会话详情），
// 不引入 react-router 之类的额外依赖。

interface NavigateOptions {
  replace?: boolean;
}

function useRoute(): [string, (path: string, opts?: NavigateOptions) => void] {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: string, opts?: NavigateOptions) => {
    if (opts?.replace) {
      window.history.replaceState({}, "", next);
    } else {
      window.history.pushState({}, "", next);
    }
    setPath(next);
  }, []);

  return [path, navigate];
}

export default function App() {
  const [path, navigate] = useRoute();

  const bootstrapMatch = path.match(/^\/bootstrap\/([^/]+)$/);
  if (bootstrapMatch) {
    const token = bootstrapMatch[1] as string;
    return (
      <BootstrapPage
        token={token}
        onDone={() => navigate("/", { replace: true })}
      />
    );
  }

  const sessionMatch = path.match(/^\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const sessionId = sessionMatch[1] as string;
    return <SessionPage sessionId={sessionId} onExit={() => navigate("/")} />;
  }

  return <HomePage onCreated={(id) => navigate(`/sessions/${id}`)} />;
}
