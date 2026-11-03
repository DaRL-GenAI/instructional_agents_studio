// diff.js — line diffs for reviewing an agent's edits: every run of changed lines is one hunk, which can be accepted
// or rejected on its own. No browser or Node APIs (the server's tests use it too).

const lines = t => { const l = String(t ?? '').split('\n'); return l; };
const MAX_CELLS = 4e6; // LCS table limit; a bigger middle section becomes a single hunk

/** a, b: texts → hunks [{ id, a, del: [lines], add: [lines] }]; `a` is the hunk's first line in the old text (0-based). */
export function diffLines(aText, bText) {
  const A = lines(aText), B = lines(bText);
  let pre = 0; while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0; while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a = A.slice(pre, A.length - suf), b = B.slice(pre, B.length - suf);
  const ops = []; // 'e' | 'd' | 'i' with the line
  if (a.length * b.length > MAX_CELLS) { for (const x of a) ops.push(['d', x]); for (const x of b) ops.push(['i', x]); }
  else {
    const n = a.length, m = b.length, W = m + 1; const L = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * W + j] = a[i] === b[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push(['e', a[i]]); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) ops.push(['d', a[i++]]);
      else ops.push(['i', b[j++]]);
    }
    while (i < n) ops.push(['d', a[i++]]); while (j < m) ops.push(['i', b[j++]]);
  }
  const hunks = []; let ai = pre, cur = null;
  for (const [op, x] of ops) {
    if (op === 'e') { cur = null; ai++; continue; }
    if (!cur) { cur = { id: hunks.length, a: ai, del: [], add: [] }; hunks.push(cur); }
    if (op === 'd') { cur.del.push(x); ai++; } else cur.add.push(x);
  }
  return hunks;
}

/** The old text with the accepted hunks applied (accepted: a Set of hunk ids, or true for all). */
export function applyHunks(aText, hunks, accepted = true) {
  const A = lines(aText); const out = []; let i = 0;
  for (const h of [...hunks].sort((x, y) => x.a - y.a)) {
    while (i < h.a) out.push(A[i++]);
    if (accepted === true || accepted.has(h.id)) { out.push(...h.add); i += h.del.length; }
    else { for (let k = 0; k < h.del.length; k++) out.push(A[i++]); }
  }
  while (i < A.length) out.push(A[i++]);
  return out.join('\n');
}

/** Rows to display a hunk with `ctx` lines of context: [{ kind: ' ' | '-' | '+', text, n }] (n: old line number, 1-based). */
export function hunkRows(aText, h, ctx = 2) {
  const A = lines(aText); const rows = [];
  for (let i = Math.max(0, h.a - ctx); i < h.a; i++) rows.push({ kind: ' ', text: A[i], n: i + 1 });
  h.del.forEach((t, k) => rows.push({ kind: '-', text: t, n: h.a + k + 1 }));
  for (const t of h.add) rows.push({ kind: '+', text: t, n: null });
  const end = h.a + h.del.length; for (let i = end; i < Math.min(A.length, end + ctx); i++) rows.push({ kind: ' ', text: A[i], n: i + 1 });
  return rows;
}
