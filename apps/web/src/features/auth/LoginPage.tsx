import { useState } from 'react';

/**
 * 登录页。适老原则：字段少、字大、错误提示直白，
 * 并且允许“先不登录、只在本机记录”——云端不该成为记录血糖的前置条件。
 */

type Props = {
  onLogin: (username: string, password: string) => Promise<void>;
  onUseLocalOnly: () => void;
};

export function LoginPage({ onLogin, onUseLocalOnly }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (username.trim() === '' || password === '') {
      setError('请填写用户名和密码');
      return;
    }
    setBusy(true);
    try {
      await onLogin(username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={submit}>
        <h2 className="login-title">登录云端记录</h2>
        <p className="hint">
          登录后，手机和电脑看到的是同一份记录。不登录也可以继续用，数据只存在这台设备上。
        </p>

        <label htmlFor="login-user">用户名</label>
        <input
          id="login-user"
          value={username}
          autoComplete="username"
          onChange={(e) => setUsername(e.target.value)}
          placeholder="请输入用户名"
        />

        <label htmlFor="login-pass">密码</label>
        <input
          id="login-pass"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          placeholder="请输入密码"
        />

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        <div className="login-actions">
          <button className="btn big" type="submit" disabled={busy}>
            {busy ? '正在登录…' : '登录'}
          </button>
          <button className="btn big ghost" type="button" onClick={onUseLocalOnly} disabled={busy}>
            先不登录，只在本机记录
          </button>
        </div>
      </form>
    </div>
  );
}
