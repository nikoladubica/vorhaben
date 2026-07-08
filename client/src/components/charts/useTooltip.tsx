// The shared chart tooltip — a port of the design file's fixed-position `#tip` pattern
// (vorhaben-design.html, showTip/hideTip). One hidden fixed div per chart; only ever one is
// visible at a time. It is reachable by BOTH mouse (showAt on mousemove) and keyboard focus
// (showAtElement on a focused mark), so hover values are also available to keyboard users.
//
// The tooltip is purely visual: it is aria-hidden and the focusable marks carry their own
// aria-labels, so assistive tech reads the same numbers without depending on this floating layer.

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

interface TipState {
  content: ReactNode;
  x: number; // anchor point in viewport coords (tooltip is centred above it)
  y: number;
}

export interface Tooltip {
  // Render this once inside the chart's container; it positions itself over the viewport.
  element: ReactNode;
  // Show at an explicit viewport point (mouse move).
  showAt: (content: ReactNode, x: number, y: number) => void;
  // Show centred above a focused element's box (keyboard focus).
  showAtElement: (content: ReactNode, target: Element) => void;
  hide: () => void;
}

export function useTooltip(): Tooltip {
  const [state, setState] = useState<TipState | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Position after render so we can measure the tip's own box, mirroring the design's clamp:
  // keep it 8px inside the viewport horizontally and float it 12px above the anchor.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !state) return;
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    const left = Math.min(Math.max(8, state.x - w / 2), window.innerWidth - w - 8);
    node.style.left = `${left}px`;
    node.style.top = `${state.y - h - 12}px`;
  }, [state]);

  const showAt = useCallback((content: ReactNode, x: number, y: number) => {
    setState({ content, x, y });
  }, []);

  const showAtElement = useCallback((content: ReactNode, target: Element) => {
    const r = target.getBoundingClientRect();
    setState({ content, x: r.left + r.width / 2, y: r.top });
  }, []);

  const hide = useCallback(() => setState(null), []);

  const element = (
    <div ref={ref} className="chart-tip" aria-hidden="true" style={{ display: state ? 'block' : 'none' }}>
      {state?.content}
    </div>
  );

  return { element, showAt, showAtElement, hide };
}
