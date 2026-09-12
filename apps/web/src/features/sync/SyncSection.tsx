import { useState } from 'react';
import type { LocalRecord } from '@gms/contracts';
import { findSlotDef } from '@gms/domain';
import type { OutboxEntry } from '../../data/local/repo';
import type { SyncStatus } from '../../data/sync/engine';

/**
 * 设置页的同步区块。
 * 冲突不自动合并：逐条让用户选择以本机还是以云端为准（架构 §6）。
 */

type Props = {
  status: SyncStatus;
  entries: OutboxEntry[];
  records: LocalRecord[];
  onLogin: () => void;
  onLogout: () => void;
  onSyncNow: () => void;
  onFullResync: () => void;
  onTakeLocal: (recordId: string) => void;
  onTakeRemote: (recordId: string) => void;
  onDiscard: (recordId: string) => void;
  onChangePassword: (oldPassword: string, newPassword: string) => Promise<void>;
};

function labelOf(record: LocalRecord | undefined, entry: OutboxEntry): string {
  const kind = record?.kind ?? entry.record?.kind ?? '';
  const slot = record?.slot ?? entry.record?.slot ?? '';
  const period = record?.periodKey ?? entry.record?.periodKey ?? '';
  const slotLabel = kind ? (findSlotDef(kind, slot)?.label ?? slot) : '';
  return `${period} ${slotLabel}`.trim() || entry.recordId.slice(0, 8);
}

const ACTION_LABEL: Record<OutboxEntry['action'], string> = {
  create: '新增',
  update: '修改',
  delete: '删除',
  restore: '恢复',
};

export function SyncSection({
  status,
  entries,
  records,
  onLogin,
  onLogout,
  onSyncNow,
  onFullResync,
  onTakeLocal,
  onTakeRemote,
  onDiscard,
  onChangePassword,
}: Props) {
  const [pwOpen, setPwOpen] = useState(false);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwBusy, setPwBusy] = useState(false);

  const byId = new Map(records.map((r) => [r.id, r]));
  const conflicts = entries.filter((e) => e.conflict);
  const failed = entries.filter((e) => !e.conflict && e.lastError !== null);

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError(null);
    if (newPw.length < 8) {
      setPwError('新密码至少 8 位');
      return;
    }
    setPwBusy(true);
    try {
      await onChangePassword(oldPw, newPw);
      setPwOpen(false);
      setOldPw('');
      setNewPw('');
    } catch (err) {
      setPwError(err instanceof Error ? err.message : '修改失败，请重试');
    } finally {
      setPwBusy(false);
    }
  };

  const statusText = !status.signedIn
    ? '未登录云端 · 数据仅存于此设备'
    : status.phase === 'syncing'
      ? '正在同步…'
      : status.conflicts > 0
        ? `有 ${status.conflicts} 条冲突待处理`
        : status.pending > 0
          ? `待同步 ${status.pending} 条`
          : status.phase === 'offline'
            ? '暂时无法连接服务器'
            : '已同步';

  return (
    <section className="card">
      <h2>云端同步</h2>
      <p className="hint">{statusText}</p>

      {status.message && <p className="hint">{status.message}</p>}
      {status.phase === 'offline' && status.message && (
        <p className="field-error" role="status">
          {status.message}
        </p>
      )}

      {status.signedIn ? (
        <>
          <p className="hint">
            已登录为 <strong>{status.username}</strong>
            {status.lastSyncAt ? ` · 上次同步 ${new Date(status.lastSyncAt).toLocaleString('zh-CN')}` : ''}
          </p>
          <div className="editor-actions">
            <button className="btn small secondary" onClick={onSyncNow} disabled={status.phase === 'syncing'}>
              立即同步
            </button>
            <button className="btn small ghost" onClick={onFullResync}>
              从云端重新拉取
            </button>
            <button className="btn small danger" onClick={onLogout}>
              退出登录
            </button>
          </div>
          <p className="hint">
            退出登录不会删除本机记录，也不会丢弃未同步的内容；重新登录后会继续上传。
          </p>

          {pwOpen ? (
            <form className="pw-form" onSubmit={submitPassword}>
              <h3 className="sync-problem-title">修改密码</h3>
              <label htmlFor="pw-old">当前密码</label>
              <input
                id="pw-old"
                type="password"
                autoComplete="current-password"
                value={oldPw}
                onChange={(e) => setOldPw(e.target.value)}
              />
              <label htmlFor="pw-new">新密码（至少 8 位）</label>
              <input
                id="pw-new"
                type="password"
                autoComplete="new-password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
              />
              {pwError && (
                <p className="field-error" role="alert">
                  {pwError}
                </p>
              )}
              <p className="hint">改完需要用新密码重新登录一次，本机记录不会丢。</p>
              <div className="editor-actions">
                <button className="btn small" type="submit" disabled={pwBusy}>
                  {pwBusy ? '正在修改…' : '确认修改'}
                </button>
                <button className="btn small ghost" type="button" onClick={() => setPwOpen(false)} disabled={pwBusy}>
                  取消
                </button>
              </div>
            </form>
          ) : (
            <div className="editor-actions">
              <button className="btn small ghost" onClick={() => setPwOpen(true)}>
                修改密码
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="hint">登录后手机与电脑看到同一份记录，换设备也能接着填。</p>
          <div className="editor-actions">
            <button className="btn small" onClick={onLogin}>
              登录云端
            </button>
          </div>
        </>
      )}

      {conflicts.length > 0 && (
        <div className="sync-problem">
          <h3 className="sync-problem-title">需要你决定（{conflicts.length} 条）</h3>
          <p className="hint">这条记录在别的设备上也被改过。请选择保留哪一份。</p>
          {conflicts.map((entry) => (
            <div key={entry.mutationId} className="sync-problem-item">
              <div className="detail-main">
                {labelOf(byId.get(entry.recordId), entry)}
                <span className="badge">{ACTION_LABEL[entry.action]}</span>
              </div>
              {entry.lastError && <div className="detail-meta">{entry.lastError}</div>}
              <div className="editor-actions">
                <button className="btn small secondary" onClick={() => onTakeLocal(entry.recordId)}>
                  用本机这版
                </button>
                <button className="btn small ghost" onClick={() => onTakeRemote(entry.recordId)}>
                  用云端那版
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {failed.length > 0 && (
        <div className="sync-problem">
          <h3 className="sync-problem-title">内容未通过校验（{failed.length} 条）</h3>
          {failed.map((entry) => (
            <div key={entry.mutationId} className="sync-problem-item">
              <div className="detail-main">
                {labelOf(byId.get(entry.recordId), entry)}
                <span className="badge">{ACTION_LABEL[entry.action]}</span>
              </div>
              {entry.lastError && <div className="detail-meta">{entry.lastError}</div>}
              <div className="editor-actions">
                <button className="btn small ghost" onClick={() => onDiscard(entry.recordId)}>
                  放弃这条修改
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
