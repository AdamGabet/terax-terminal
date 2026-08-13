export type Segment = {
  label: string;
  fullPath: string;
  isHome: boolean;
};

const WINDOWS_DRIVE = /^([A-Za-z]:)(.*)$/;

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

export function segmentsFromCwd(cwd: string, home: string | null): Segment[] {
  const normCwd = normalize(cwd);
  const normHome = home !== null ? normalize(home) : null;

  const usingHome =
    normHome !== null &&
    (normCwd === normHome || normCwd.startsWith(normHome + "/"));

  let rootSegment: Segment;
  let tail: string;

  if (usingHome) {
    rootSegment = { label: "~", fullPath: normHome!, isHome: true };
    tail = normCwd.slice(normHome!.length).replace(/^\//, "");
  } else {
    const driveMatch = WINDOWS_DRIVE.exec(normCwd);
    if (driveMatch) {
      const drive = driveMatch[1];
      rootSegment = { label: drive, fullPath: drive + "/", isHome: false };
      tail = driveMatch[2].replace(/^\//, "");
    } else {
      rootSegment = { label: "/", fullPath: "/", isHome: false };
      tail = normCwd.replace(/^\//, "");
    }
  }

  const parts = tail === "" ? [] : tail.split("/").filter(Boolean);
  const segments: Segment[] = [rootSegment];

  let acc = rootSegment.fullPath;
  for (const part of parts) {
    acc = acc.endsWith("/") ? acc + part : acc + "/" + part;
    segments.push({ label: part, fullPath: acc, isHome: false });
  }
  return segments;
}

export type SegmentSplit = {
  /** Root anchor (~ / drive / "/"). Always shown. */
  head: Segment | null;
  /** Segments hidden behind the "…" menu (oldest, past the cap). */
  collapsed: Segment[];
  /** Visible non-root segments (nearest `cap`, current dir is the last). */
  visible: Segment[];
};

/** Split a segment list for display: keep the root anchor plus the last `cap`
 * segments visible, collapsing everything in between. `cap <= 0` shows the
 * whole path. */
export function splitSegments(segments: Segment[], cap: number): SegmentSplit {
  if (segments.length === 0) {
    return { head: null, collapsed: [], visible: [] };
  }
  const head = segments[0];
  const rest = segments.slice(1);
  if (cap > 0 && rest.length > cap) {
    return {
      head,
      collapsed: rest.slice(0, rest.length - cap),
      visible: rest.slice(rest.length - cap),
    };
  }
  return { head, collapsed: [], visible: rest };
}
