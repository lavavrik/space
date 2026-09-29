import { useEffect } from 'react';

/**
 * Keep the left column (location and its panels) clear of the ship gauges below it: set its
 * max-height (the CSS variable --left-max) to the room above the gauges, measured whenever either
 * changes size. A fixed allowance in rem went stale as the gauges grew (integrity, cargo), and
 * tall panels ran under them.
 */
export function useLeftRoom(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const fit = () => {
      const left = document.getElementById('leftcol'),
        gauges = document.getElementById('gauges');
      if (!left || !gauges) return;
      const room = gauges.getBoundingClientRect().top - left.getBoundingClientRect().top - 12;
      left.style.setProperty('--left-max', `${Math.max(120, room)}px`);
    };
    const ro = new ResizeObserver(fit);
    const gauges = document.getElementById('gauges');
    if (gauges) ro.observe(gauges);
    addEventListener('resize', fit);
    fit();
    return () => {
      ro.disconnect();
      removeEventListener('resize', fit);
    };
  }, [active]);
}
