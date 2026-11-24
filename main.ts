// main.ts — mend, the CLI SPEC.md specifies.
//
// The kit's starting point (MIT) does sections 1 to 4, 9 and 10 of SPEC.md:
// the command line, the output and exit codes, safe paths, format
// detection, JSON edits and the all-or-nothing write. Sections 5 to 8 are
// written here: matching lines at three tiers, unified diffs,
// SEARCH/REPLACE blocks and V4A patches. Node 22, the standard library
// alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];
type Format = string;

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

// A file seen as lines, plus the line break it uses and whether it ends
// with one. The line break is CRLF when the file's first line feed follows
// a carriage return, and LF otherwise.
interface FileModel {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function readModel(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: true };
  let final = true;
  let body = text;
  if (body.endsWith(br)) body = body.slice(0, -br.length);
  else final = false;
  return { lines: body.split(br), br, final };
}

function writeModel(m: FileModel): string {
  return m.lines.join(m.br) + (m.lines.length > 0 && m.final ? m.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

// One line of a patch hunk: its text, and whether it is a context line
// (present in both the old and the new side).
interface Line {
  text: string;
  ctx: boolean;
}

// Positions where `old` occurs in `lines` at one matching tier, at or
// after `from`. Tier 0 is exact, tier 1 ignores trailing spaces and tabs,
// tier 2 ignores leading and trailing spaces and tabs.
function tierPositions(lines: string[], old: string[], tier: number, from: number): number[] {
  const norm = (s: string): string => (tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s));
  const want = old.map(norm);
  const pos: number[] = [];
  for (let i = from; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (norm(lines[i + j]) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

// The first tier (exact, then trailing-whitespace, then both ends) at
// which `old` occurs at least once, or null when it never occurs. With
// --strict only the exact tier is tried.
function findFirstTier(
  lines: string[],
  old: string[],
  from: number,
  strict: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = tierPositions(lines, old, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

// The replacement lines for a hunk matched at `pos`. Context lines keep
// the file's own text (so their exact whitespace survives). At tier 2 a
// new line that starts with the old side's base indent has that indent
// replaced by the file's base indent; other lines are written as they are.
function buildReplacement(fileLines: string[], pos: number, o: Line[], n: Line[], tier: number): string[] {
  const out: string[] = [];
  const oCtx: number[] = [];
  o.forEach((e, i) => {
    if (e.ctx) oCtx.push(i);
  });
  const p = o.length > 0 ? leadWs(o[0].text) : '';
  const f = pos < fileLines.length ? leadWs(fileLines[pos]) : '';
  let rank = 0;
  for (const e of n) {
    if (e.ctx) {
      out.push(fileLines[pos + oCtx[rank++]]);
    } else if (tier === 2 && e.text !== '' && e.text.trim() !== '' && e.text.startsWith(p)) {
      out.push(f + e.text.slice(p.length));
    } else {
      out.push(e.text);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// Moves recorded by edits, so the final report can show a rename as one
// R line instead of a separate D and A. Reset at the start of each run.
let moves: { old: string; new: string }[] = [];
function recordMove(oldPath: string, newPath: string): void {
  moves.push({ old: oldPath, new: newPath });
}

// ---------------------------------------------------------------------------
// JSON edits: one JSON array of edit objects, or JSON Lines: one edit
// object a line, blank lines ignored. In array form any fault is
// `error: parse <the line where the array starts>`; in JSON Lines form a
// line that does not hold one valid edit object is `error: parse <that
// line>`. An edit object has a string `path` and a `command`; keys other
// than those below are ignored.
//
// - create: the file does not exist (else `exists`); written with
//   `file_text`'s bytes.
// - str_replace: `old_str` a non-empty string, `new_str` a string (absent
//   is empty). The file exists (else `missing`). In a CRLF file, the file's
//   text and both strings are read with every `\r\n` as `\n`, and the
//   result is written back with `\r\n`. `old_str` occurs in the text
//   exactly once (positions may overlap), else `no-match` or `ambiguous`;
//   it is replaced by `new_str`. No tier applies: the match is exact.
// - insert: `insert_line` an integer, `new_str` a string. The file exists
//   (else `missing`), and `insert_line` is from 0 to its number of lines
//   (else `no-match`). `new_str`'s lines are inserted after line
//   `insert_line` (0 is the top). The file's final break stays as it was.
/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs.
//
// A patch is a run of sections. A section starts at a `diff --git` line or
// at a `--- <old>` / `+++ <new>` pair, and holds hunks of the form
// `@@ -A[,B] +C[,D] @@` followed by body lines: ` ` context, `-` old,
// `+` new, `\` (no-newline marker), or an empty line (empty context).
// The body ends at the next section start, at a line that is none of those,
// or at the end of the patch; empty lines at the end of a body are not
// part of it.
interface Hunk {
  a: number;
  body: string[];
}

interface Section {
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  gitOld: string | null;
  gitNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

// A path as written after --- / +++: up to the first tab, surrounding
// spaces removed, and a leading a/ or b/ removed.
function parseDiffPath(raw: string): string {
  let p = raw.split('\t')[0].trim();
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const fresh = (): Section => ({
    pairOld: null,
    pairNew: null,
    renameOld: null,
    renameNew: null,
    gitOld: null,
    gitNew: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = m[1];
      cur.gitNew = m[2];
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.pairOld = parseDiffPath(line.slice(4));
        cur.pairNew = parseDiffPath(lines[i + 1].slice(4));
      } else {
        cur = fresh();
        cur.pairOld = parseDiffPath(line.slice(4));
        cur.pairNew = parseDiffPath(lines[i + 1].slice(4));
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader && line.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1], 10);
      i++;
      const body: string[] = [];
      while (i < lines.length) {
        const b = lines[i];
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a, body });
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  return sections;
}

// Applies one section's hunks to a file model. Each hunk is matched at
// the first tier where it occurs, at the occurrence nearest to where the
// hunk header says it belongs (offset by earlier hunks in the same file).
// A `\` line after a hunk's last context or `+` line means the result has
// no final line break when the hunk touches the end of the file.
function applyUnifiedHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): FileModel {
  let lines = [...model.lines];
  const br = model.br;
  let final = model.final;
  let d = 0;
  for (const h of hunks) {
    const o: Line[] = [];
    const n: Line[] = [];
    for (const b of h.body) {
      if (b.startsWith(' ')) {
        o.push({ text: b.slice(1), ctx: true });
        n.push({ text: b.slice(1), ctx: true });
      } else if (b.startsWith('-')) o.push({ text: b.slice(1), ctx: false });
      else if (b.startsWith('+')) n.push({ text: b.slice(1), ctx: false });
      else if (b === '') {
        o.push({ text: '', ctx: true });
        n.push({ text: '', ctx: true });
      }
    }
    let backslash = false;
    for (let j = h.body.length - 1; j >= 0; j--) {
      const b = h.body[j];
      if (b.startsWith(' ') || b === '' || b.startsWith('+')) {
        backslash = j + 1 < h.body.length && h.body[j + 1].startsWith('\\');
        break;
      }
    }
    if (o.length > 0) {
      const found = findFirstTier(lines, o.map((e) => e.text), 0, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + o.length === lines.length;
      const repl = buildReplacement(lines, best, o, n, found.tier);
      lines.splice(best, o.length, ...repl);
      if (atEnd) final = !backslash;
    } else {
      const idx = Math.min(h.a + d, lines.length);
      const atEnd = idx === lines.length;
      const repl = n.map((e) => e.text);
      lines.splice(idx, 0, ...repl);
      if (atEnd) final = !backslash;
    }
    d += n.length - o.length;
  }
  return { lines, br, final };
}

function unifiedSectionEdit(s: Section, strict: boolean): Edit {
  const oldPath = s.pairOld ?? s.renameOld ?? s.gitOld;
  const newPath = s.pairNew ?? s.renameNew ?? s.gitNew;
  const creation = oldPath === '/dev/null' || s.newFile;
  const deletion = newPath === '/dev/null' || s.deletedFile;
  return (tree) => {
    if (!creation && oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (!deletion && newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (creation) {
      const np = newPath as string;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const outLines: string[] = [];
      let finalBreak = true;
      let lastPlusHunk = -1;
      let lastPlusIdx = -1;
      s.hunks.forEach((h, hi) => {
        h.body.forEach((b, bi) => {
          if (b.startsWith('+')) {
            lastPlusHunk = hi;
            lastPlusIdx = bi;
          }
        });
      });
      s.hunks.forEach((h, hi) => {
        h.body.forEach((b) => {
          if (b.startsWith('+')) outLines.push(b.slice(1));
        });
        if (
          hi === lastPlusHunk &&
          lastPlusIdx + 1 < h.body.length &&
          h.body[lastPlusIdx + 1].startsWith('\\')
        ) {
          finalBreak = false;
        }
      });
      tree.now.set(np, outLines.length === 0 ? '' : outLines.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (deletion) {
      const op = oldPath as string;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldPath as string;
    const np = newPath as string;
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    if (op !== np && tree.get(np) !== null) throw new Fail('exists', np);
    const result = applyUnifiedHunks(readModel(cur), s.hunks, strict, op);
    const content = writeModel(result);
    if (op !== np) {
      tree.now.set(np, content);
      tree.now.set(op, null);
      recordMove(op, np);
    } else {
      tree.now.set(op, content);
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks.
//
//   <path>
//   <<<<<<< SEARCH
//   <old lines>
//   =======
//   <new lines>
//   >>>>>>> REPLACE
//
// The path is the nearest non-blank, non-fence line above the SEARCH
// marker; when there is none, the previous block's path is used. Empty
// old lines create a new file. Otherwise the old lines must occur exactly
// once in the file (at the first matching tier), or the edit fails.
interface SRBlock {
  path: string;
  old: string[];
  nw: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') {
      const searchIdx = i;
      let path: string | null = null;
      for (let j = searchIdx - 1; j > prevEnd; j--) {
        const t = lines[j];
        if (blank(t)) continue;
        if (t.trim().startsWith('```')) continue;
        path = t.trim();
        break;
      }
      if (path === null) {
        if (prevPath !== null) path = prevPath;
        else throw new Exit2(`error: parse ${searchIdx + 1}`);
      }
      let eq = -1;
      for (let j = searchIdx + 1; j < lines.length; j++) {
        if (lines[j].trimEnd() === '=======') {
          eq = j;
          break;
        }
        if (lines[j].trimEnd() === '>>>>>>> REPLACE' || lines[j].trimEnd() === '<<<<<<< SEARCH') break;
      }
      if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
        if (lines[j].trimEnd() === '<<<<<<< SEARCH') break;
      }
      if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
      blocks.push({ path, old: lines.slice(searchIdx + 1, eq), nw: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevEnd = rep;
      i = rep + 1;
      continue;
    }
    i++;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const model = readModel(cur);
    const found = findFirstTier(model.lines, b.old, 0, strict);
    if (!found) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0];
    const o = b.old.map((t) => ({ text: t, ctx: false }));
    const n = b.nw.map((t) => ({ text: t, ctx: false }));
    const repl = buildReplacement(model.lines, pos, o, n, found.tier);
    const lines = [...model.lines];
    lines.splice(pos, o.length, ...repl);
    tree.now.set(b.path, writeModel({ lines, br: model.br, final: model.final }));
  };
}

// ---------------------------------------------------------------------------
// V4A patches.
//
//   *** Begin Patch
//   *** Add File: <path>
//   +<line> ...
//   *** Delete File: <path>
//   *** Update File: <path>
//   *** Move to: <path>        (optional, first line of an update)
//   @@ <anchor>                (optional; empty text means no anchor)
//   <body lines: ' ' context, '-' old, '+' new, '' empty context>
//   *** End of File            (optional, marks the chunk as end-of-file)
//   *** End Patch
//
// A chunk applies at the first occurrence of its old lines at or after
// the cursor, at the first matching tier; an end-of-file chunk only
// matches at the end of the file. An anchor moves the cursor just past
// the first line at or after the cursor equal to the anchor. After a
// chunk the cursor sits just after the lines written. Blank lines at the
// end of a section, and blank lines between sections, are not part of it.
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last])) last--;
  if (last < 0 || lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    const m = /^\*\*\* (Add File|Delete File|Update File): (.*)$/.exec(line);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1] === 'Add File' ? 'add' : m[1] === 'Delete File' ? 'delete' : 'update';
    const sec: VSection = { kind, path: m[2].trim(), moveTo: null, lines: [], chunks: [] };
    const sectionLine = i + 1;
    i++;
    if (kind === 'add') {
      while (i < last) {
        const l = lines[i];
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l === '') {
          sec.lines.push('');
          i++;
          continue;
        }
        if (l.startsWith('+')) {
          sec.lines.push(l.slice(1));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (sec.lines.length > 0 && sec.lines[sec.lines.length - 1] === '') sec.lines.pop();
    } else if (kind === 'delete') {
      while (i < last) {
        const l = lines[i];
        if (blank(l)) {
          i++;
          continue;
        }
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        throw new Exit2(`error: parse ${i + 1}`);
      }
    } else {
      if (i < last && lines[i].startsWith('*** Move to: ')) {
        sec.moveTo = lines[i].slice('*** Move to: '.length).trim();
        i++;
      }
      let cur: VChunk | null = null;
      let started = false;
      const endChunk = (): void => {
        if (cur !== null) {
          sec.chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const l = lines[i];
        if (l.startsWith('@@')) {
          endChunk();
          cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
          started = true;
          i++;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          endChunk();
          i++;
          continue;
        }
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (started) {
              if (blank(l)) {
                i++;
                continue;
              }
              throw new Exit2(`error: parse ${i + 1}`);
            }
            cur = { anchor: null, eof: false, body: [] };
            started = true;
          }
          cur.body.push(l);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      endChunk();
      if (sec.chunks.length > 0) {
        const lastChunk = sec.chunks[sec.chunks.length - 1];
        while (lastChunk.body.length > 0 && blank(lastChunk.body[lastChunk.body.length - 1])) lastChunk.body.pop();
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
    }
    sections.push(sec);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => vSectionEdit(s, strict));
}

function vSectionEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const cur = tree.get(s.path);
    if (cur === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const model = readModel(cur);
    const lines = [...model.lines];
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const found = findFirstTier(lines, [ch.anchor], cursor, strict);
        if (!found) throw new Fail('no-match', s.path);
        cursor = found.positions[0] + 1;
      }
      const o: Line[] = [];
      const n: Line[] = [];
      for (const b of ch.body) {
        if (b.startsWith(' ')) {
          o.push({ text: b.slice(1), ctx: true });
          n.push({ text: b.slice(1), ctx: true });
        } else if (b.startsWith('-')) o.push({ text: b.slice(1), ctx: false });
        else if (b.startsWith('+')) n.push({ text: b.slice(1), ctx: false });
        else if (b === '') {
          o.push({ text: '', ctx: true });
          n.push({ text: '', ctx: true });
        }
      }
      if (o.length > 0) {
        const found = findFirstTier(lines, o.map((e) => e.text), cursor, strict);
        if (!found) throw new Fail('no-match', s.path);
        let pos: number | null = null;
        for (const p of found.positions) {
          if (ch.eof && p + o.length !== lines.length) continue;
          pos = p;
          break;
        }
        if (pos === null) throw new Fail('no-match', s.path);
        const repl = buildReplacement(lines, pos, o, n, found.tier);
        lines.splice(pos, o.length, ...repl);
        cursor = pos + repl.length;
      } else {
        const idx = ch.eof ? lines.length : cursor;
        const repl = n.map((e) => e.text);
        lines.splice(idx, 0, ...repl);
        cursor = idx + repl.length;
      }
    }
    const content = writeModel({ lines, br: model.br, final: model.final });
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, content);
      tree.now.set(s.path, null);
      recordMove(s.path, s.moveTo);
    } else {
      tree.now.set(s.path, content);
    }
  };
}

// ---------------------------------------------------------------------------
// Format detection. With `--format=auto` the format is the first of these
// that holds, where a blank line is one that is empty or only whitespace:
// the first non-blank line is `*** Begin Patch` (v4a); the first
// non-whitespace character of the first non-blank line is `[` or `{`
// (json); some line is `<<<<<<< SEARCH` (search-replace); some line starts
// with `diff --git `, or some line starts with `--- ` and the line after
// it starts with `+++ ` (unified). Otherwise it is `error: format`. A
// format named with `--format` is read as that format whatever the text
// holds.
function detect(lines: string[]): Format | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  )
    return 'unified';
  return null;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: Format | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  moves = [];
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') {
      const sections = parseUnified(lines);
      if (sections.length === 0) throw new Exit2('error: parse 1');
      edits = sections.map((s) => unifiedSectionEdit(s, strict));
    } else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0)
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  const rows = new Map<string, string>();
  for (const p of tree.now.keys()) {
    if (tree.original(p) === tree.now.get(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p);
    rows.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  // A rename or move is one R line: one edit deleted the old path and
  // another created the new path, with neither path existing before or
  // surviving after under its old name.
  for (const m of moves) {
    const oldRow = rows.get(m.old);
    const newRow = rows.get(m.new);
    if (!oldRow || !newRow) continue;
    if (tree.original(m.old) === null) continue;
    if (tree.original(m.new) !== null) continue;
    if (tree.now.get(m.old) !== null) continue;
    if (tree.now.get(m.new) === null) continue;
    if (!oldRow.startsWith('D ') || !newRow.startsWith('A ')) continue;
    rows.delete(m.old);
    rows.delete(m.new);
    rows.set(m.new, `R ${m.old} -> ${m.new}`);
  }
  const sorted = [...rows.entries()].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  const out = [...sorted.map(([, line]) => line), `ok: ${sorted.length} ${sorted.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of tree.now.keys()) {
      if (tree.original(p) === tree.now.get(p)) continue;
      const now = tree.now.get(p);
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
