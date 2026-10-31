import type { JSX } from "solid-js";

/**
 * Icon set. SinglePath SVGs on a 24-grid, stroked with currentColor so a
 * parent's `color` is the only styling needed. Kept in one module so the shell
 * pays ~3 KB for every icon in the app rather than shipping an icon font.
 */
const P: Record<string, string> = {
  folder: "M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.5.7l1 1.3H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  folderOpen:
    "M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.5.7l1 1.3H19a2 2 0 0 1 2 2v1M3.6 19h13.1a2 2 0 0 0 1.9-1.4l1.3-4.1a1 1 0 0 0-1-1.3H6.4a2 2 0 0 0-1.9 1.4l-1.3 4.1a1 1 0 0 0 1 1.3z",
  file: "M6 3h7l5 5v13a0 0 0 0 1 0 0H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM13 3v5h5",
  fileText: "M6 3h7l5 5v13H6zM13 3v5h5M9 13h6M9 17h4",
  image: "M4 5h16v14H4zM4 16l4-4 3 3 3-3 6 5M15.5 9.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  audio: "M9 18V6l10-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM19 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  video: "M3 6h13v12H3zM16 10l5-3v10l-5-3z",
  archive: "M4 4h16v4H4zM6 8v12h12V8M10 12h4M10 16h4",
  code: "M9 8l-4 4 4 4M15 8l4 4-4 4",
  pdf: "M6 3h7l5 5v13H6zM13 3v5h5M9 14h1.5a1.5 1.5 0 0 0 0-3H9v6M14 11v6h1.5a1.5 1.5 0 0 0 1.5-1.5v-3A1.5 1.5 0 0 0 15.5 11z",
  sheet: "M4 5h16v14H4zM4 10h16M4 15h16M10 5v14",
  arrowLeft: "M15 5l-7 7 7 7",
  arrowRight: "M9 5l7 7-7 7",
  arrowUp: "M12 19V5M5 12l7-7 7 7",
  chevronRight: "M9 5l7 7-7 7",
  chevronDown: "M5 9l7 7 7-7",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  settings:
    "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 2.6 14H2.4a2 2 0 1 1 0-4h.2A1.7 1.7 0 0 0 4.3 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 2.6h.1a2 2 0 1 1 4 0v.2A1.7 1.7 0 0 0 15 4.3a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21.4 9v.1a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1.2z",
  close: "M6 6l12 12M18 6L6 18",
  list: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  grid: "M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z",
  plus: "M12 5v14M5 12h14",
  splitH: "M3 4h18v16H3zM12 4v16",
  splitV: "M3 4h18v16H3zM3 12h18",
  palette:
    "M12 21a9 9 0 1 1 0-18c5 0 9 3.6 9 8 0 2.8-2.2 5-5 5h-1.5a2 2 0 0 0-1.4 3.4A1.9 1.9 0 0 1 12 21zM7.5 11.5h.01M10 8h.01M14 8h.01M16.5 11.5h.01",
  eye: "M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff: "M4 4l16 16M10.6 6.2A9.9 9.9 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3 3.6M6.3 8.3A16 16 0 0 0 2 12s3.6 6 10 6c1.3 0 2.5-.2 3.5-.6M9.9 9.9a3 3 0 0 0 4.2 4.2",
  trash: "M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6",
  edit: "M4 20h4l10-10-4-4L4 16zM14 6l4 4",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1",
  terminal: "M4 5h16v14H4zM7 9l3 3-3 3M13 15h4",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01",
  check: "M4 12.5l5 5L20 6.5",
  refresh: "M20 11a8 8 0 1 0-2.3 6.3M20 5v6h-6",
  home: "M4 11l8-7 8 7M6 10v10h12V10",
  star: "M12 3l2.9 6 6.6.9-4.8 4.6 1.2 6.5-5.9-3.2-5.9 3.2 1.2-6.5L3.5 9.9 10.1 9z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  drive: "M3 12h18M6 12V7a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5M4 12v6h16v-6M8 15h.01",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5",
  zap: "M13 2L4 14h7l-1 8 9-12h-7z",
  gauge: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zM12 12l4-3",
  dot: "M12 12h.01",
  scissors: "M6 6l12 12M6 18L18 6M8 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM8 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0z",
  clipboard: "M9 4h6v3H9zM7 5H5v16h14V5h-2M9 12h6M9 16h4",
  filter: "M3 5h18l-7 8v6l-4-2v-4z",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.9 2.1 2.1.9-2.1.9L19 21l-.9-2.1-2.1-.9 2.1-.9z",
  keyboard: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M8 14h8",
  pin: "M12 17v5M9 3h6l-1 7 3 3H7l3-3z",
  sound: "M11 5L6 9H3v6h3l5 4zM16 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11",
};

export type IconName = keyof typeof P | string;

export function Icon(props: {
  name: IconName;
  size?: number;
  class?: string;
  style?: JSX.CSSProperties;
  fill?: boolean;
}) {
  const d = () => P[props.name] ?? P.file;
  return (
    <svg
      viewBox="0 0 24 24"
      width={props.size ?? 16}
      height={props.size ?? 16}
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      style={props.style}
      aria-hidden="true"
    >
      <path d={d()} />
    </svg>
  );
}

/** Best-effort icon for a file, by extension. Used by every view plugin. */
export function iconFor(entry: { kind: number; ext?: string; name: string }): IconName {
  if (entry.kind === 1) return "folder";
  if (entry.kind === 2) return "external";
  if (entry.kind === 3) return "archive";
  const ext = (entry.ext ?? entry.name.split(".").pop() ?? "").toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico", "svg"].includes(ext)) return "image";
  if (["mp3", "wav", "flac", "ogg", "m4a", "aac"].includes(ext)) return "audio";
  if (["mp4", "mkv", "mov", "webm", "avi"].includes(ext)) return "video";
  if (["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"].includes(ext)) return "archive";
  if (["pdf"].includes(ext)) return "pdf";
  if (["csv", "tsv", "xlsx", "ods"].includes(ext)) return "sheet";
  if (["rs", "ts", "tsx", "js", "jsx", "py", "go", "rb", "c", "h", "cpp", "java", "sh", "fish", "sql", "css", "html"].includes(ext))
    return "code";
  if (["md", "markdown", "txt", "rst", "log"].includes(ext)) return "fileText";
  return "file";
}
