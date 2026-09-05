/** 简笔画图标：加粗黑色轮廓线，无填充细节，放大清晰（MyTurn 适老风格） */

type IconProps = { size?: number };

function svg(path: React.ReactNode, size = 40) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke="#141414"
      strokeWidth={3.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

export function IconGlucose({ size }: IconProps) {
  return svg(
    <>
      <path d="M24 6C24 6 12 21 12 30a12 12 0 0 0 24 0C36 21 24 6 24 6Z" />
      <circle cx={24} cy={30} r={4} />
    </>,
    size,
  );
}

export function IconBloodPressure({ size }: IconProps) {
  return svg(
    <>
      <path d="M24 42C11 31 7 21 13 14a8.5 8.5 0 0 1 11-1 8.5 8.5 0 0 1 11 1c6 7 2 17-11 28Z" />
      <path d="M16 25h5l3-6 4 10 3-4h5" />
    </>,
    size,
  );
}

export function IconWeight({ size }: IconProps) {
  return svg(
    <>
      <circle cx={24} cy={24} r={17} />
      <path d="M24 24l8-9" />
      <path d="M14 24h3M24 12v3M31 15l-2 2" />
    </>,
    size,
  );
}

export function IconMeal({ size }: IconProps) {
  return svg(
    <>
      <path d="M8 26h32a16 16 0 0 1-32 0Z" />
      <path d="M24 26v8" />
      <path d="M30 4l7 18M37 3l6 17" />
    </>,
    size,
  );
}

export function IconWater({ size }: IconProps) {
  return svg(
    <>
      <path d="M15 6h18l-2.5 32a4 4 0 0 1-4 4h-5a4 4 0 0 1-4-4L15 6Z" />
      <path d="M17 22h14" />
    </>,
    size,
  );
}

export function IconExercise({ size }: IconProps) {
  return svg(
    <>
      <path d="M15 24h18" />
      <rect x={5} y={14} width={9} height={20} rx={2} />
      <rect x={34} y={14} width={9} height={20} rx={2} />
    </>,
    size,
  );
}

export function IconInsulin({ size }: IconProps) {
  return svg(
    <>
      <rect x={19} y={7} width={10} height={22} rx={2} />
      <path d="M24 29v9M21 38h6M19 14h10M19 20h10" />
      <path d="M24 3v4" />
    </>,
    size,
  );
}

export function IconNote({ size }: IconProps) {
  return svg(
    <>
      <rect x={11} y={7} width={26} height={35} rx={4} />
      <path d="M17 17h14M17 24h14M17 31h9" />
    </>,
    size,
  );
}

export function IconCheck({ size = 36 }: IconProps) {
  return svg(<path d="M10 26l9 9L38 12" />, size);
}

export function IconHistory({ size }: IconProps) {
  return svg(
    <>
      <rect x={7} y={9} width={34} height={32} rx={4} />
      <path d="M16 5v8M32 5v8M7 19h34M16 27h8" />
    </>,
    size,
  );
}

export function IconTrend({ size }: IconProps) {
  return svg(
    <>
      <path d="M7 38l10-11 8 6 15-17" />
      <path d="M31 15h9v9" />
    </>,
    size,
  );
}

export function IconSettings({ size }: IconProps) {
  return svg(
    <>
      <circle cx={24} cy={24} r={8} />
      <path d="M24 6v6M24 36v6M6 24h6M36 24h6M11 11l4 4M33 33l4 4M37 11l-4 4M15 33l-4 4" />
    </>,
    size,
  );
}

export function IconPen({ size }: IconProps) {
  return svg(
    <>
      <path d="M13 35l2-7L33 10a3.5 3.5 0 0 1 5 5L20 33l-7 2Z" />
      <path d="M30 13l5 5" />
    </>,
    size,
  );
}
