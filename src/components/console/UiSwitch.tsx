'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { setUiMode } from '../../app/console-actions';

/**
 * Switch between the two interfaces.
 *
 * Both drive the same data and the same approval path; they differ only in how you
 * find the thing you want to change. The preference is remembered per person.
 */
export default function UiSwitch({
  mode,
  cardKey,
}: {
  mode: 'sheet' | 'console';
  cardKey: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const go = (next: 'sheet' | 'console') => {
    startTransition(async () => {
      await setUiMode(next);
      router.push(next === 'sheet' ? `/sheets/${cardKey}/surface` : `/console/${cardKey}/rates`);
    });
  };

  return (
    <span className="uiswitch" role="group" aria-label="Interface">
      <a
        href={`/console/${cardKey}/rates`}
        aria-current={mode === 'console' ? 'page' : undefined}
        onClick={(event) => {
          event.preventDefault();
          go('console');
        }}
      >
        Console
      </a>
      <a
        href={`/sheets/${cardKey}/surface`}
        aria-current={mode === 'sheet' ? 'page' : undefined}
        onClick={(event) => {
          event.preventDefault();
          go('sheet');
        }}
      >
        Sheet
      </a>
    </span>
  );
}
