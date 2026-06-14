import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ParsedEvent } from '../types.js';
import type { Store } from '../store/index.js';
import { parseLine } from './parser.js';
import { normalizeRepo } from './repo.js';

const HEAD_BYTES = 256;

export type IngestSummary = {
  files_scanned: number;
  new_events: number;
};

export function defaultLogsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/** Find every *.jsonl file under `root` (recursively). Returns absolute paths. */
export function findJsonlFiles(root: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith('.jsonl')) continue;
    // `parentPath` (Node ≥ 20.12); older Node populates the deprecated `path` field instead.
    const dirent = e as Dirent & { parentPath?: string; path?: string };
    const parent = dirent.parentPath ?? dirent.path ?? root;
    out.push(join(parent, e.name));
  }
  return out;
}

/** Hash the first HEAD_BYTES bytes (or the whole file if shorter) — used to detect rotation. */
function headHash(filePath: string, sizeBytes: number): string {
  const len = Math.min(HEAD_BYTES, sizeBytes);
  if (len === 0) return '';
  const buf = Buffer.alloc(len);
  const fd = openSync(filePath, 'r');
  try {
    readSync(fd, buf, 0, len, 0);
  } finally {
    closeSync(fd);
  }
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

/**
 * Incrementally read new content from `filePath` since the stored watermark.
 * Returns a list of parsed events (without repo normalization) and the new
 * watermark to persist.
 */
function readNewLines(
  filePath: string,
  prevByteOffset: number,
): { lines: string[]; newOffset: number } {
  // Slurp the suffix; JSONL files are small enough that this is fine in v1.
  // (Single Claude Code session files are typically <50MB; we re-read only
  // the unconsumed tail.)
  const buf = readFileSync(filePath);
  if (buf.length <= prevByteOffset) return { lines: [], newOffset: prevByteOffset };
  const slice = buf.subarray(prevByteOffset).toString('utf-8');
  const parts = slice.split('\n');
  // `parts` always ends with the trailing-after-last-\n segment; drop it as
  // incomplete (may still be written to).
  const complete = parts.slice(0, -1);
  let consumed = 0;
  for (const l of complete) consumed += Buffer.byteLength(l, 'utf-8') + 1;
  return { lines: complete, newOffset: prevByteOffset + consumed };
}

export type CollectorOptions = {
  logsRoot?: string;
};

/**
 * Run one ingest pass: scan every JSONL file under `logsRoot`, parse new lines
 * since each file's watermark, dedupe via `(session_id, line_hash)`, and write
 * to the store. Idempotent: a second call with no new data returns 0 events.
 */
export function ingestOnce(store: Store, opts: CollectorOptions = {}): IngestSummary {
  const root = opts.logsRoot ?? defaultLogsRoot();
  const files = findJsonlFiles(root);
  let totalNew = 0;

  for (const file of files) {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size === 0) continue;

    const wm = store.getWatermark(file);
    const currentHead = headHash(file, size);
    let startOffset = 0;
    if (wm) {
      if (wm.head_hash === currentHead && wm.byte_offset <= size) {
        startOffset = wm.byte_offset;
      }
      // Else: file rotated (head changed) or truncated — restart from 0.
    }

    const { lines, newOffset } = readNewLines(file, startOffset);
    const events: ParsedEvent[] = [];
    for (const line of lines) {
      const parsed = parseLine(line);
      if (!parsed) continue;
      events.push({
        ...parsed,
        repo: normalizeRepo(parsed.cwd),
      });
    }

    if (events.length > 0) totalNew += store.insertEvents(events);
    store.setWatermark({ file_path: file, byte_offset: newOffset, head_hash: currentHead });
  }

  return { files_scanned: files.length, new_events: totalNew };
}
