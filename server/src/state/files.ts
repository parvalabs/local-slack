import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** A file as the mock tracks it. The Slack-shaped object bots see is built from
 *  this by formatFile (web-api/format.ts), so URLs always reflect the running
 *  server's --base-host rather than whatever it was when the file was stored. */
export interface StoredFile {
  id: string;
  name: string;
  title: string;
  /** The uploader — a human user id, or an app's bot user id. */
  user: string;
  created: number;
  mimetype: string;
  filetype: string;
  prettyType: string;
  altTxt?: string;
  size: number;
  /** Where the bytes live on disk. Unset until they've been uploaded, which is
   *  what separates a file mid-upload (between getUploadURLExternal and the POST
   *  to its upload_url) from a usable one. */
  path?: string;
  /** Every message it's been shared in, oldest first. */
  shares: { channel: string; ts: string; thread_ts?: string }[];
  deleted: boolean;
}

/** Slack's filetype / pretty_type for common extensions. Anything else is
 *  reported as "binary", which is also what Slack falls back to. */
const TYPES: Record<string, [filetype: string, prettyType: string]> = {
  png: ["png", "PNG"],
  jpg: ["jpg", "JPEG"],
  jpeg: ["jpg", "JPEG"],
  gif: ["gif", "GIF"],
  webp: ["webp", "WebP"],
  svg: ["svg", "SVG"],
  bmp: ["bmp", "BMP"],
  heic: ["heic", "HEIC"],
  pdf: ["pdf", "PDF"],
  txt: ["text", "Plain Text"],
  log: ["text", "Plain Text"],
  md: ["markdown", "Markdown (raw)"],
  csv: ["csv", "CSV"],
  tsv: ["tsv", "TSV"],
  json: ["json", "JSON"],
  yaml: ["yaml", "YAML"],
  yml: ["yaml", "YAML"],
  xml: ["xml", "XML"],
  html: ["html", "HTML"],
  js: ["javascript", "JavaScript"],
  ts: ["typescript", "TypeScript"],
  py: ["python", "Python"],
  sh: ["shell", "Shell"],
  sql: ["sql", "SQL"],
  zip: ["zip", "Zip"],
  gz: ["gzip", "GZip"],
  tar: ["tar", "Tar"],
  mp3: ["mp3", "MP3"],
  wav: ["wav", "WAV"],
  mp4: ["mp4", "MPEG 4 Video"],
  mov: ["mov", "QuickTime Movie"],
  webm: ["webm", "WebM"],
  doc: ["doc", "Word Document"],
  docx: ["docx", "Word Document"],
  xls: ["xls", "Excel Spreadsheet"],
  xlsx: ["xlsx", "Excel Spreadsheet"],
  ppt: ["ppt", "PowerPoint Presentation"],
  pptx: ["pptx", "PowerPoint Presentation"],
};

/**
 * Uploaded files: metadata in memory, bytes on disk — the bytes can be large,
 * and keeping them out of the heap is the point of storing locally.
 *
 * Lives exactly as long as the in-memory workspace it belongs to: reset() clears
 * it along with the messages that reference it. Each file sits in its own
 * `<dir>/<id>/` so an upload can keep its original name without colliding.
 */
export class FileStore {
  private readonly files = new Map<string, StoredFile>();
  private readonly uploadTokens = new Map<string, string>(); // upload_url token -> file id
  private resolvedDir: string | undefined;
  /** Whether we created `dir` ourselves (a temp dir), and so may remove it. */
  private readonly ownsDir: boolean;

  constructor(
    private readonly newId: (prefix: string) => string,
    dir?: string,
  ) {
    this.resolvedDir = dir;
    this.ownsDir = !dir;
  }

  /** Created on first use, so a run (or a test) that never touches files never
   *  leaves an empty temp dir behind. */
  get dir(): string {
    if (!this.resolvedDir) this.resolvedDir = mkdtempSync(join(tmpdir(), "local-slack-files-"));
    else mkdirSync(this.resolvedDir, { recursive: true });
    return this.resolvedDir;
  }

  /** Registers a file that has a name but no bytes yet. */
  create(opts: { name: string; title?: string; user: string; altTxt?: string; snippetType?: string }): {
    file: StoredFile;
    uploadToken: string;
  } {
    const name = opts.name || "file";
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    const [filetype, prettyType] = opts.snippetType
      ? [opts.snippetType, opts.snippetType]
      : (TYPES[ext] ?? ["binary", "Binary"]);
    const file: StoredFile = {
      id: this.newId("F"),
      name,
      title: opts.title || name,
      user: opts.user,
      created: Math.floor(Date.now() / 1000),
      // Bun infers this from the extension alone; the path needn't exist.
      mimetype: Bun.file(name).type.split(";")[0] || "application/octet-stream",
      filetype,
      prettyType,
      ...(opts.altTxt ? { altTxt: opts.altTxt } : {}),
      size: 0,
      shares: [],
      deleted: false,
    };
    const uploadToken = crypto.randomUUID().replaceAll("-", "");
    this.files.set(file.id, file);
    this.uploadTokens.set(uploadToken, file.id);
    return { file, uploadToken };
  }

  get(id: string | undefined): StoredFile | undefined {
    return id ? this.files.get(id) : undefined;
  }

  byUploadToken(token: string): StoredFile | undefined {
    return this.get(this.uploadTokens.get(token));
  }

  /** Every file whose bytes have arrived and that hasn't been deleted. */
  all(): StoredFile[] {
    return [...this.files.values()].filter((f) => f.path && !f.deleted);
  }

  async write(file: StoredFile, data: Blob | ArrayBuffer | Uint8Array): Promise<void> {
    const safeName = basename(file.name).replace(/[\0/\\]/g, "_") || "file";
    const path = join(this.dir, file.id, safeName);
    file.size = await Bun.write(path, data);
    file.path = path;
  }

  /** Drops a file's bytes. The record stays, flagged deleted, so lookups can
   *  answer `file_deleted` rather than `file_not_found` — as Slack does. */
  remove(file: StoredFile): void {
    this.removeBytes(file);
    file.deleted = true;
  }

  /** Forgets every file and removes their bytes (workspace reset). */
  clear(): void {
    for (const file of this.files.values()) this.removeBytes(file);
    this.files.clear();
    this.uploadTokens.clear();
  }

  /** Process exit: removes the temp dir if we made it. A --files-dir the user
   *  chose is theirs and is left alone. */
  dispose(): void {
    if (this.ownsDir && this.resolvedDir) rmSync(this.resolvedDir, { recursive: true, force: true });
  }

  private removeBytes(file: StoredFile): void {
    if (!file.path || !this.resolvedDir) return;
    rmSync(join(this.resolvedDir, file.id), { recursive: true, force: true });
    file.path = undefined;
  }
}
