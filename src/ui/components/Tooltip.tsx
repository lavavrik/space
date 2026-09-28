/*
 * HUD tooltips, positioned with Floating UI (@floating-ui/react): they open on hover (after a short
 * delay) or keyboard focus, flip and shift to stay on screen, and render in a portal so a panel's
 * clip-path never cuts them off. Styled like the HUD panels (hud.css, .tip). They only show while
 * the mouse is free: with the pointer captured for steering there's no hover.
 */
import {
  FloatingArrow, FloatingPortal, arrow, autoUpdate, flip, offset, shift, useDismiss, useFloating, useFocus, useHover, useInteractions, useRole,
  type Placement,
} from '@floating-ui/react';
import { useRef, useState, type ReactNode } from 'react';

export function Tip({ content, children, className, placement = 'top' }: { content: ReactNode; children: ReactNode; className?: string; placement?: Placement }) {
  const [open, setOpen] = useState(false);
  const arrowRef = useRef<SVGSVGElement>(null);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip(), shift({ padding: 8 }), arrow({ element: arrowRef })],
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useHover(context, { delay: { open: 120, close: 0 }, move: false }),
    useFocus(context),
    useDismiss(context),
    useRole(context, { role: 'tooltip' }),
  ]);
  return (
    <>
      <span ref={refs.setReference} className={className} tabIndex={0} {...getReferenceProps()}>
        {children}
      </span>
      {open && (
        <FloatingPortal>
          <div ref={refs.setFloating} className="tip" style={floatingStyles} {...getFloatingProps()}>
            {content}
            <FloatingArrow ref={arrowRef} context={context} className="tiparrow" width={10} height={5} />
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
