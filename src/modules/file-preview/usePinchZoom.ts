import { useEffect, useLayoutEffect, useRef } from "react";

// WebKit (the Tauri webview on macOS) reports trackpad pinch two ways: a
// `wheel` event with `ctrlKey` set, and the non-standard `gesture*` events
// whose `scale` is cumulative since `gesturestart`. We treat both as a
// multiplicative factor on the current zoom so the two paths share one math.
type GestureEvent = Event & {
  scale: number;
  clientX: number;
  clientY: number;
};

// The content fraction under the cursor at the moment of a zoom step, plus the
// cursor's offset within the viewport. Applied after the DOM resizes to keep
// that same content point under the cursor.
type Anchor = { fx: number; fy: number; px: number; py: number };

/**
 * Wires trackpad pinch (and ctrl+wheel) on `ref` to a zoom setter, anchoring
 * the zoom at the pointer: the content point under the cursor stays put while
 * the rest scales around it. The caller owns the zoom state; clamping to
 * `range` happens here. No-ops while `ref.current` is null (a hidden tab).
 */
export function usePinchZoom(
  ref: React.RefObject<HTMLElement | null>,
  zoom: number,
  setZoom: (z: number) => void,
  range: { min: number; max: number },
): void {
  const { min, max } = range;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const anchorRef = useRef<Anchor | null>(null);

  // After the zoom change has been committed and the content re-laid-out (this
  // runs synchronously before paint, so scrollWidth/Height are the NEW sizes),
  // restore the anchored point. Using measured sizes — not an analytic factor —
  // keeps it correct across the fit→overflow transition and rapid steps.
  useLayoutEffect(() => {
    const el = ref.current;
    const a = anchorRef.current;
    if (!el || !a) return;
    anchorRef.current = null;
    el.scrollLeft = a.fx * el.scrollWidth - a.px;
    el.scrollTop = a.fy * el.scrollHeight - a.py;
  }, [ref, zoom]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const clamp = (z: number) => Math.min(max, Math.max(min, z));

    const applyZoom = (step: number, clientX: number, clientY: number) => {
      const prev = zoomRef.current;
      const next = clamp(prev * step);
      if (next === prev) return;
      const rect = el.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      // Fraction of total scrollable content currently under the cursor.
      anchorRef.current = {
        fx: el.scrollWidth > 0 ? (el.scrollLeft + px) / el.scrollWidth : 0,
        fy: el.scrollHeight > 0 ? (el.scrollTop + py) / el.scrollHeight : 0,
        px,
        py,
      };
      setZoom(next);
    };

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // plain scroll / pan — leave it alone
      e.preventDefault();
      applyZoom(Math.exp(-e.deltaY / 100), e.clientX, e.clientY);
    };

    // `gesture*.scale` is cumulative since gesturestart, so step = s / last.
    let lastScale = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      lastScale = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureEvent;
      const scale = g.scale || 1;
      applyZoom(scale / lastScale, g.clientX, g.clientY);
      lastScale = scale;
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
    // `zoom` is read through zoomRef so the listeners never need re-attaching.
  }, [ref, setZoom, min, max]);
}
