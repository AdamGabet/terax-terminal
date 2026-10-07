export type PreviewKind = "image" | "pdf" | "table";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  avif: "image/avif",
};

const TABLE_EXTS = ["csv", "tsv", "xls", "xlsx"];

export const PREVIEWABLE_EXTENSIONS = [
  ...Object.keys(IMAGE_MIME),
  "pdf",
  ...TABLE_EXTS,
];

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "";
  return path.slice(dot + 1).toLowerCase();
}

/** "image" / "pdf" / "table" when the path can be shown in a file-preview tab. */
export function previewKindForPath(path: string): PreviewKind | null {
  const ext = extOf(path);
  if (ext === "pdf") return "pdf";
  if (ext in IMAGE_MIME) return "image";
  if ((TABLE_EXTS as string[]).includes(ext)) return "table";
  return null;
}

export function mimeForPath(path: string): string {
  const ext = extOf(path);
  if (ext === "pdf") return "application/pdf";
  return IMAGE_MIME[ext] ?? "application/octet-stream";
}
