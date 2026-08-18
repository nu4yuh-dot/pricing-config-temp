'use client';

import { useEffect, useRef } from 'react';

/**
 * A masthead nav group.
 *
 * The markup is a plain <details> so the menu works without JavaScript and still closes
 * with Escape on its own. Three things do need the client, because a <details> has no
 * opinion about any of them:
 *
 *  - App Router navigation is soft, so the layout is never remounted and a menu left
 *    open stays open over the page it just navigated to. Close it on selection.
 *  - Two <details> can be open at once. Opening one closes its siblings, so the nav
 *    behaves like a menu bar rather than a row of independent accordions.
 *  - A click outside dismisses it, which is what a dropdown is expected to do.
 */
export default function NavMenu({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const onDocumentPointerDown = (event: MouseEvent) => {
      const el = ref.current;
      if (el?.open && !el.contains(event.target as Node)) el.open = false;
    };
    document.addEventListener('pointerdown', onDocumentPointerDown);
    return () => document.removeEventListener('pointerdown', onDocumentPointerDown);
  }, []);

  return (
    <details
      ref={ref}
      onToggle={() => {
        const el = ref.current;
        if (!el?.open) return;
        // Only one group open at a time. The siblings are the other groups in this nav.
        el.parentElement?.querySelectorAll('details').forEach((other) => {
          if (other !== el) other.open = false;
        });
      }}
    >
      <summary>{label}</summary>
      <div
        className="menu"
        onClick={(event) => {
          // Only a real choice closes the menu — a click on the padding between links
          // is not a selection.
          if ((event.target as HTMLElement).closest('a')) {
            if (ref.current) ref.current.open = false;
          }
        }}
      >
        {children}
      </div>
    </details>
  );
}
