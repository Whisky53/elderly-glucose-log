import { useEffect, useRef } from 'react';

type Props = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/** 高影响操作确认弹窗：关闭后焦点回到触发处（PRD §6） */
export function ConfirmDialog({ title, message, confirmLabel, cancelLabel = '取消', onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    openerRef.current = document.activeElement;
    confirmRef.current?.focus();
    return () => {
      (openerRef.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(10,16,28,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 40,
        padding: '1rem',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="card" style={{ maxWidth: '26rem', width: '100%', marginBottom: 0 }} onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}>
        <h2>{title}</h2>
        <p style={{ fontSize: '0.95rem' }}>{message}</p>
        <div className="editor-actions">
          <button ref={confirmRef} className="btn danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
          <button className="btn secondary" onClick={onCancel}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
