import type { Units } from '../../app/App';

type Props = {
  fontSize: string;
  onFontSize: (s: string) => void;
  units: Units;
  onUnits: (u: Units) => void;
  onSeed: () => Promise<void>;
  onClear: () => Promise<void>;
};

const FONT_OPTIONS = [
  { size: '18', label: '标准 18px' },
  { size: '22', label: '大 22px（默认）' },
  { size: '26', label: '特大 26px' },
];

export function SettingsPage({ fontSize, onFontSize, units, onUnits, onSeed, onClear }: Props) {
  return (
    <div>
      <div className="card">
        <h2>字号</h2>
        {FONT_OPTIONS.map((o) => (
          <div key={o.size} className="radio-row">
            <input
              type="radio"
              id={`fs-${o.size}`}
              name="fontsize"
              checked={fontSize === o.size}
              onChange={() => onFontSize(o.size)}
            />
            <label htmlFor={`fs-${o.size}`} style={{ margin: 0, fontSize: '1rem', color: 'inherit' }}>
              {o.label}
            </label>
          </div>
        ))}
        <p className="hint">更换字号不刷新页面，正在填写的内容不会丢失；本设备会记住选择。</p>
      </div>

      <div className="card">
        <h2>单位配置 <span className="badge warn">待确认</span></h2>
        <p className="hint">以下为设计默认值，需在实际使用前确认。修改只影响之后记录的默认单位；历史记录的原值和单位不变，不做换算。</p>
        <label htmlFor="u-glucose">血糖单位</label>
        <select
          id="u-glucose"
          value={units.glucose}
          onChange={(e) => onUnits({ ...units, glucose: e.target.value })}
        >
          <option value="mmol/L">mmol/L</option>
          <option value="mg/dL">mg/dL</option>
        </select>
        <label htmlFor="u-weight">体重单位</label>
        <select id="u-weight" value={units.weight} onChange={(e) => onUnits({ ...units, weight: e.target.value })}>
          <option value="kg">kg</option>
        </select>
        <label htmlFor="u-water">饮水单位</label>
        <select id="u-water" value={units.water} onChange={(e) => onUnits({ ...units, water: e.target.value })}>
          <option value="mL">mL</option>
        </select>
      </div>

      <div className="card">
        <h2>数据（演示与评审用）</h2>
        <div className="editor-actions" style={{ marginTop: 0 }}>
          <button className="btn secondary" onClick={() => void onSeed()}>
            载入虚构示例数据
          </button>
          <button className="btn danger" onClick={() => void onClear()}>
            清空本地数据
          </button>
        </div>
        <p className="hint">示例数据全部为虚构，用于查看月表和趋势效果；正式使用前请清空。</p>
      </div>

      <div className="card">
        <h2>账户</h2>
        <p style={{ fontSize: '0.95rem' }}>
          当前为本地开发版，数据仅存于此设备，未连接云端账户。云端登录（邀请开通、邮箱＋密码）与多端同步将在 S2
          阶段接入，接入前不会假装已同步。
        </p>
      </div>

      <div className="card">
        <h2>添加桌面图标</h2>
        <p className="hint">
          Windows（Edge）：菜单 → 应用 → 将此站点作为应用安装。iPhone/iPad（Safari）：分享 → 添加到主屏幕。安装后从图标打开，与浏览器使用同一份数据。
        </p>
      </div>
    </div>
  );
}
