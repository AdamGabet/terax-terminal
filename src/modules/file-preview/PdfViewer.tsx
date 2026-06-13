/**
 * In-app PDF renderer built on pdf.js. The webview cannot show PDFs natively
 * (`object-src 'none'` CSP blocks <embed>, and WKWebView only paints the
 * first page of embedded PDFs anyway), so pages are rasterized to canvases.
 * Pages render lazily as they scroll into view; pdf.js itself is loaded on
 * demand so the chunk only ships when a PDF tab is opened.
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type PdfjsModule = typeof import("pdfjs-dist");
type PdfDocument = import("pdfjs-dist").PDFDocumentProxy;

let pdfjsPromise: Promise<PdfjsModule> | null = null;

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

const ZOOM_LEVELS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2, 3];
const PAGE_GAP_PX = 12;
const PAGE_MARGIN_PX = 16;

type Props = {
  /** Raw PDF bytes. Ownership transfers to the pdf.js worker. */
  data: Uint8Array;
};

export function PdfViewer({ data }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  // Width available for a page at zoom 1 (container minus margins).
  const [baseWidth, setBaseWidth] = useState(0);

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

  const zoomBy = (dir: 1 | -1) => {
    setZoom((z) => {
      const idx = ZOOM_LEVELS.findIndex((l) => l >= z - 0.001);
      const next = Math.min(
        Math.max(idx === -1 ? ZOOM_LEVELS.length - 1 : idx + dir, 0),
        ZOOM_LEVELS.length - 1,
      );
      return ZOOM_LEVELS[next];
    });
  };

  const pageWidth = Math.floor(baseWidth * zoom);

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
            onClick={() => setZoom(1)}
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
          <div
            className="mx-auto flex w-fit flex-col"
            style={{ padding: PAGE_MARGIN_PX, gap: PAGE_GAP_PX }}
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
  const [visible, setVisible] = useState(false);
  const [aspect, setAspect] = useState<number | null>(null);

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
    void doc.getPage(pageNo).then((page) => {
      const canvas = canvasRef.current;
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
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNo, width, visible]);

  return (
    <div
      ref={holderRef}
      className="bg-white shadow-sm ring-1 ring-border/60"
      style={{ width, height: Math.round(width * (aspect ?? DEFAULT_ASPECT)) }}
    >
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
