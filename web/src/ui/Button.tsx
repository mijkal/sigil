// ui/Button + IconButton — the glass button primitives for the UI kit. Variants
// frost with the theme tokens (see .ui-btn-* in index.css), so a single style tweak
// restyles every adopting button — the whole point of consolidating here.
import type { CSSProperties, ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'glass' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const pad: Record<Size, string> = { sm: '5px 10px', md: '8px 14px', lg: '10px 18px' };
const font: Record<Size, number> = { sm: 12, md: 13, lg: 14 };

export function Button({
  variant = 'glass',
  size = 'md',
  className,
  style,
  children,
  ...rest
}: {
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`ui-btn ui-btn-${variant}${className ? ` ${className}` : ''}`}
      style={{ padding: pad[size], fontSize: font[size], ...style }}
      {...rest}
    >
      {children}
    </button>
  );
}

// IconButton — square glyph button (transparent, glass hover). min 32/24px.
export function IconButton({
  size = 'md',
  title,
  className,
  style,
  children,
  ...rest
}: {
  size?: Size;
  className?: string;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const px = size === 'sm' ? 24 : size === 'lg' ? 38 : 32;
  return (
    <button
      title={title}
      aria-label={rest['aria-label'] ?? title}
      className={`ui-icon-btn${className ? ` ${className}` : ''}`}
      style={{ width: px, height: px, fontSize: size === 'sm' ? 12 : 14, ...(style as CSSProperties) }}
      {...rest}
    >
      {children}
    </button>
  );
}
