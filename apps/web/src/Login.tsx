import { useState } from "react";
import { api, type User } from "./api.ts";

export function Login({ canRegister, onLogin }: { canRegister: boolean; onLogin: (u: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = mode === "login" ? await api.login(username, password) : await api.register(username, password);
      onLogin(r.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form onSubmit={submit} className="card">
        <h2>帮帮图图</h2>
        <input placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        <input placeholder="密码（至少 8 位）" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="primary" disabled={busy || !username || !password}>
          {mode === "login" ? "登录" : "注册"}
        </button>
        {canRegister && (
          <button type="button" className="link" onClick={() => setMode(mode === "login" ? "register" : "login")}>
            {mode === "login" ? "没有账号？注册（最多 3 个）" : "已有账号？登录"}
          </button>
        )}
        {error && <div className="error-text">{error}</div>}
      </form>
    </div>
  );
}
