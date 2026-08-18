'use client';

import { useRef } from 'react';

/**
 * A masthead nav group.
 *
 * The markup is a plain <details> so the menu works without JavaScript, but App Router
 * navigation is a soft one: the DOM is never remounted, so a <details> left open stays
 * open over the page you just navigated to. Closing it on selection is the only part
 * that needs the client.
 */
export default function NavMenu({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  return (
    <details ref={ref}>
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
