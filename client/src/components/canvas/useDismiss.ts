// Close-on-outside-click + close-on-Escape for the canvas popovers (feeling / trend). Presentational
// helper only — no API, no app state. Pass the container ref and a close callback; it wires the
// document listeners while `open` and tears them down when it closes or unmounts.

import { useEffect } from 'react';
import type { RefObject } from 'react';

export function useDismiss(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return;

    function onPointerDown(e: PointerEvent) {
      const el = containerRef.current;
      if (el && !el.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, containerRef, onClose]);
}
