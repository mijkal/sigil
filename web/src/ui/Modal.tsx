// ui/Modal — the accessible modal primitive for the UI kit.
// Handles what the ad-hoc inline modals (HostModal, SetupModal, AboutMenu) each
// re-implemented inconsistently or skipped: role/aria, Escape to close,
// click-outside, a Tab focus-trap, and focus restoration to the trigger on
// close. Fully theme-token styled (light + dark). No business logic.
import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  children,
  labelledBy,
  width = 340,
  placement = 'center',
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
  width?: number;
  /** center: dialogs; top: top-centered (command palette); top-start: menus
   * anchored to the top-left banner. */
  placement?: 'center' | 'top' | 'top-start';
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    prevFocus.current = document.activeElement as HTMLElement | null;
    // Focus the first focusable element, or the card itself.
    const card = cardRef.current;
    const first = card?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? card)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !card) return;
      const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      // Restore focus to whatever opened the modal.
      prevFocus.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      style={placement === 'center' ? st.overlayCenter : placement === 'top' ? st.overlayTop : st.overlayTopStart}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        style={{ ...st.card, width }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

const st: Record<string, CSSProperties> = {
  overlayCenter: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
    backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000, padding: 16,
  },
  overlayTop: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
    backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
    zIndex: 1000, padding: 16, paddingTop: '14vh',
  },
  overlayTopStart: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
    backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
    display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start',
    zIndex: 1000, padding: 14,
  },
  // Frosted-glass card — translucent panel + heavy backdrop blur, a subtle
  // brand-tinted rim + inner top highlight. Theme-token based, so it frosts dark
  // in the dark theme and light in the light theme.
  card: {
    position: 'relative', maxWidth: '92vw', maxHeight: '90vh', overflowY: 'auto',
    background: 'color-mix(in srgb, var(--color-panel) 82%, transparent)',
    backdropFilter: 'blur(22px) saturate(1.5)', WebkitBackdropFilter: 'blur(22px) saturate(1.5)',
    border: '1px solid color-mix(in srgb, var(--color-border) 85%, transparent)',
    borderRadius: 16,
    boxShadow: '0 28px 70px rgba(0,0,0,0.6), 0 0 0 1px color-mix(in srgb, var(--color-accent) 8%, transparent), inset 0 1px 0 rgba(255,255,255,0.06)',
    outline: 'none', fontFamily: 'var(--font-ui)',
  },
};
