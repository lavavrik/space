import { useEffect, useState } from 'react';

/** `?touch` in the address forces the touch layout, for trying it on a desktop. */
const forced = () => new URLSearchParams(location.search).has('touch');

/**
 * Whether to show the touch layout (ui/components/TouchControls.tsx and the compact HUD in
 * styles/touch.css): a coarse primary pointer (phone, tablet), or any finger touching the screen
 * (a laptop with a touch screen). Sets the `touch` class on <body>, which the CSS keys off.
 */
export function useTouchMode(): boolean {
  const [touch, setTouch] = useState(() => forced() || matchMedia('(pointer: coarse)').matches);
  useEffect(() => {
    const mq = matchMedia('(pointer: coarse)');
    const onMq = () => setTouch(forced() || mq.matches);
    const onTouch = (e: PointerEvent) => {
      if (e.pointerType === 'touch') setTouch(true);
    };
    mq.addEventListener('change', onMq);
    addEventListener('pointerdown', onTouch, { passive: true });
    return () => {
      mq.removeEventListener('change', onMq);
      removeEventListener('pointerdown', onTouch);
    };
  }, []);
  useEffect(() => {
    document.body.classList.toggle('touch', touch);
  }, [touch]);
  return touch;
}
