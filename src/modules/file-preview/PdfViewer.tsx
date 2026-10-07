/**
 * In-app PDF renderer built on pdf.js. The webview cannot show PDFs natively
 * (`object-src 'none'` CSP blocks <embed>, and WKWebView only paints the
 * first page of embedded PDFs anyway), so pages are rasterized to canvases
 * with a transparent pdf.js TextLayer over each one for text selection, plus
 * a hover button to copy the page as an image. Pages render lazily as they
 * scroll into view; pdf.js itself is loaded on demand so the chunk only
 * ships when a PDF tab is opened.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import "./pdfTextLayer.css";

type PdfjsModule = typeof import("pdfjs-dist");
type PdfViewerModule = typeof import("pdfjs-dist/web/pdf_viewer.mjs");
type PdfDocument = import("pdfjs-dist").PDFDocumentProxy;

// WebKit pinch events (see usePinchZoom): `scale` is cumulative since
// gesturestart; clientX/Y give the pointer.
type GestureEvent = Event & {
  scale: number;
  clientX: number;
  clientY: number;
};

let pdfjsPromise: Promise<PdfjsModule> | null = null;
let pdfViewerPromise: Promise<PdfViewerModule> | null = null;

function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]).then(([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

function loadPdfViewer(): Promise<PdfViewerModule> {
  pdfViewerPromise ??= import("pdfjs-dist/web/pdf_viewer.mjs");
  return pdfViewerPromise;
}

const ZOOM_LEVELS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2, 3];
const PAGE_GAP_PX = 12;
const PAGE_MARGIN_PX = 16;

type Props = {
  /** Raw PDF bytes. Ownership transfers to the pdf.js worker. */
  data: Uint8Array;
};

export function PdfViewer({ data }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `zoom` is the live display zoom — during a pinch it only drives a cheap CSS
  // scale on the already-rendered canvases. `rasterZoom` is what pages are
  // actually rasterized at; it lags and catches up when the gesture settles, so
  // pdf.js re-renders once instead of on every step (the source of the lag).
  const [zoom, setZoom] = useState(1);
  const [rasterZoom, setRasterZoom] = useState(1);
  // Width available for a page at zoom 1 (container minus margins).
  const [baseWidth, setBaseWidth] = useState(0);

  const MIN_ZOOM = ZOOM_LEVELS[0];
  const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const rasterZoomRef = useRef(rasterZoom);
  rasterZoomRef.current = rasterZoom;
  // Captured at the start of a pinch burst so the point under the cursor stays
  // put: `origin` is the transform-origin in page-column-local px; `anchor` is
  // the content fraction + pointer offset used to fix scroll on commit.
  const originRef = useRef({ x: 0, y: 0 });
  const anchorRef = useRef<{
    fx: number;
    fy: number;
    px: number;
    py: number;
  } | null>(null);
  const commitTimer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    let loadingTask: { destroy: () => Promise<void> } | null = null;
    setDoc(null);
    setError(null);
    loadPdfjs()
      .then((pdfjs) => {
        if (!alive) return;
        // Copy: the worker takes ownership of the buffer and detaches it, and
        // the caller's bytes must survive a remount (tab switches re-render).
        const task = pdfjs.getDocument({ data: data.slice() });
        loadingTask = task;
        return task.promise;
      })
      .then((d) => {
        if (d && alive) setDoc(d);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
      // Destroying the loading task also destroys the document and worker port.
      void loadingTask?.destroy();
    };
  }, [data]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () =>
      setBaseWidth(Math.max(0, el.clientWidth - PAGE_MARGIN_PX * 2));
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Trackpad pinch / ctrl+wheel zoom. During the gesture only `zoom` updates
  // (a CSS scale — cheap); the expensive rasterization is debounced to when the
  // gesture settles. Continuous within the discrete levels' span.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

    const step = (factor: number, clientX: number, clientY: number) => {
      const prev = zoomRef.current;
      const next = clamp(prev * factor);
      if (next === prev) return;
      // At the start of a burst (no preview pending yet) capture the anchor and
      // the transform-origin, then keep them fixed for the rest of the burst.
      if (prev === rasterZoomRef.current) {
        const rect = el.getBoundingClientRect();
        const px = clientX - rect.left;
        const py = clientY - rect.top;
        anchorRef.current = {
          fx: el.scrollWidth > 0 ? (el.scrollLeft + px) / el.scrollWidth : 0,
          fy: el.scrollHeight > 0 ? (el.scrollTop + py) / el.scrollHeight : 0,
          px,
          py,
        };
        const col = columnRef.current;
        if (col) {
          const cr = col.getBoundingClientRect();
          originRef.current = { x: clientX - cr.left, y: clientY - cr.top };
        }
      }
      setZoom(next);
      if (commitTimer.current) clearTimeout(commitTimer.current);
      commitTimer.current = window.setTimeout(() => {
        commitTimer.current = null;
        setRasterZoom(zoomRef.current);
      }, 160);
    };

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      step(Math.exp(-e.deltaY / 100), e.clientX, e.clientY);
    };
    let lastScale = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      lastScale = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureEvent;
      const scale = g.scale || 1;
      step(scale / lastScale, g.clientX, g.clientY);
      lastScale = scale;
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      if (commitTimer.current) clearTimeout(commitTimer.current);
    };
  }, [MIN_ZOOM, MAX_ZOOM]);

  // When rasterZoom catches up the pages re-render at the new width; restore the
  // anchored point so the cursor stays put across the swap.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchorRef.current;
    if (!el || !a) return;
    anchorRef.current = null;
    el.scrollLeft = a.fx * el.scrollWidth - a.px;
    el.scrollTop = a.fy * el.scrollHeight - a.py;
  }, [rasterZoom]);

  // Buttons snap through the discrete levels and rasterize immediately.
  const zoomBy = (dir: 1 | -1) => {
    const idx = ZOOM_LEVELS.findIndex((l) => l >= zoom - 0.001);
    const clamped = Math.min(
      Math.max(idx === -1 ? ZOOM_LEVELS.length - 1 : idx + dir, 0),
      ZOOM_LEVELS.length - 1,
    );
    setZoom(ZOOM_LEVELS[clamped]);
    setRasterZoom(ZOOM_LEVELS[clamped]);
  };

  const resetZoom = () => {
    setZoom(1);
    setRasterZoom(1);
  };

  const pageWidth = Math.floor(baseWidth * rasterZoom);
  // CSS scale applied during a pinch, before rasterZoom catches up.
  const previewScale = rasterZoom > 0 ? zoom / rasterZoom : 1;

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
        <span className="px-1 text-[11px] text-muted-foreground">
          {doc ? `${doc.numPages} page${doc.numPages === 1 ? "" : "s"}` : "…"}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-5 text-[13px] text-muted-foreground"
            aria-label="Zoom out"
            disabled={zoom <= ZOOM_LEVELS[0]}
            onClick={() => zoomBy(-1)}
          >
            −
          </Button>
          <button
            type="button"
            className="w-10 rounded-sm px-1 py-0.5 text-center text-[11px] tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Reset zoom"
            onClick={resetZoom}
          >
            {Math.round(zoom * 100)}%
          </button>
          <Button
            variant="ghost"
            size="icon"
            className="size-5 text-[13px] text-muted-foreground"
            aria-label="Zoom in"
            disabled={zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
            onClick={() => zoomBy(1)}
          >
            +
          </Button>
        </div>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {error && (
          <p className="px-6 py-4 text-[12px] text-destructive">
            Failed to render PDF: {error}
          </p>
        )}
        {!error && !doc && (
          <p className="px-6 py-4 text-[12px] text-muted-foreground">
            Loading…
          </p>
        )}
        {doc && pageWidth > 0 && (
          // Outer flex centers the page column when it's narrower than the
          // pane, but lets it grow past the pane when zoomed in — so the
          // scroll container pans left/right as well as up/down. `safe`
          // centering falls back to start on overflow so the left edge stays
          // reachable (plain centering / `mx-auto` clips it).
          <div className="flex min-w-full [justify-content:safe_center]">
            <div
              ref={columnRef}
              className="flex w-fit flex-col"
              style={{
                padding: PAGE_MARGIN_PX,
                gap: PAGE_GAP_PX,
                transform:
                  previewScale !== 1 ? `scale(${previewScale})` : undefined,
                transformOrigin:
                  previewScale !== 1
                    ? `${originRef.current.x}px ${originRef.current.y}px`
                    : undefined,
              }}
            >
              {Array.from({ length: doc.numPages }, (_, i) => (
                <PdfPage
                  key={`${i + 1}`}
                  doc={doc}
                  pageNo={i + 1}
                  width={pageWidth}
                  scrollRoot={scrollRef}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Aspect ratio (h/w) used for the placeholder until the real page reports its
// own. US Letter-ish; only affects scrollbar accuracy before first render.
const DEFAULT_ASPECT = 1.294;

function PdfPage({
  doc,
  pageNo,
  width,
  scrollRoot,
}: {
  doc: PdfDocument;
  pageNo: number;
  width: number;
  scrollRoot: React.RefObject<HTMLDivElement | null>;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerHostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [aspect, setAspect] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { root: scrollRoot.current, rootMargin: "1000px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    if (!visible || width <= 0) return;
    let cancelled = false;
    let task: ReturnType<import("pdfjs-dist").PDFPageProxy["render"]> | null =
      null;
    let textLayer:
      | import("pdfjs-dist/web/pdf_viewer.mjs").TextLayerBuilder
      | null = null;
    void Promise.all([loadPdfViewer(), doc.getPage(pageNo)]).then(
      ([pdfViewer, page]) => {
        const canvas = canvasRef.current;
        const textHost = textLayerHostRef.current;
        if (cancelled || !canvas) return;
        const base = page.getViewport({ scale: 1 });
        setAspect(base.height / base.width);
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const viewport = page.getViewport({ scale: width / base.width });
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        task = page.render({
          canvas,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        // Cancellation rejects with RenderingCancelledException — expected.
        task.promise.catch(() => {});
        // Selectable-text overlay: transparent spans over the canvas, rebuilt
        // whenever the raster width changes so glyphs track the zoom.
        if (textHost) {
          textHost.replaceChildren();
          textLayer = new pdfViewer.TextLayerBuilder({
            pdfPage: page,
            onAppend: (div: HTMLDivElement) => {
              if (!cancelled) textHost.replaceChildren(div);
            },
          });
          const textDiv = textLayer.div;
          textDiv.classList.add("trx-textLayer", "select-text");
          // Consumed by pdfTextLayer.css (`--total-scale-factor` must equal
          // the viewport scale for the text to align with the canvas).
          textDiv.style.setProperty(
            "--total-scale-factor",
            String(viewport.scale),
          );
          textDiv.style.setProperty("--scale-round-x", "1px");
          textDiv.style.setProperty("--scale-round-y", "1px");
          // TextLayerBuilder installs pdf.js's selectionchange handling and
          // end-of-content anchor; using TextLayer directly misses both.
          void textLayer
            .render({ viewport, images: undefined as never })
            .catch((e) => {
              if (!cancelled) console.error("[pdf] text layer failed", e);
            });
        }
      },
    );
    return () => {
      cancelled = true;
      task?.cancel();
      try {
        textLayer?.cancel();
      } catch {
        // Already settled — ignore.
      }
    };
  }, [doc, pageNo, width, visible]);

  const copyImage = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      void navigator.clipboard
        .write([new ClipboardItem({ "image/png": blob })])
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        })
        .catch(() => {
          // Clipboard unavailable — ignore.
        });
    }, "image/png");
  };

  return (
    <div
      ref={holderRef}
      className="group relative bg-white shadow-sm ring-1 ring-border/60"
      style={{ width, height: Math.round(width * (aspect ?? DEFAULT_ASPECT)) }}
    >
      <canvas ref={canvasRef} className="h-full w-full" />
      <div ref={textLayerHostRef} className="absolute inset-0" />
      <Button
        variant="secondary"
        size="sm"
        className="absolute top-1 right-1 z-10 h-6 px-2 text-[11px] opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        onClick={copyImage}
      >
        {copied ? "Copied" : "Copy image"}
      </Button>
    </div>
  );
}
