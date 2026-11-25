/**
 * Line-based diff3 merge for offline report edits.
 *
 * diff3(base, local, server) -> { clean, merged, conflicts }
 * - clean: every region resolved automatically (one side unchanged, or
 *   both sides made the identical change); merged holds the result text.
 * - otherwise merged carries <<<<<<< / ======= / >>>>>>> markers and
 *   conflicts lists each overlapping region ({base, local, server}) for
 *   the manual resolution UI.
 *
 * Independent implementation of the classic diff3 region algorithm
 * (LCS line matches -> change hunks -> overlapping-region sweep); the
 * sync design references obsidian-fast-note-sync's offline auto-merge
 * semantics (Apache-2.0), not its code.
 */

/** Ascending [baseIndex, otherIndex] pairs of identical lines (LCS). */
function lcsMatches(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Change hunks in base coordinates: {bs, be, os, oe} (half-open). */
function hunks(base, other, matches) {
  const hs = [];
  let bi = 0;
  let oi = 0;
  const sentinels = [...matches, [base.length, other.length]];
  for (const [mb, mo] of sentinels) {
    if (mb > bi || mo > oi) hs.push({ bs: bi, be: mb, os: oi, oe: mo });
    bi = mb + 1;
    oi = mo + 1;
  }
  return hs;
}

/** Extract one side's lines covering base region [bFrom, bTo). */
function extract(hs, i0, other, bFrom, bTo, oFrom) {
  const lines = [];
  let b = bFrom;
  let o = oFrom;
  let i = i0;
  const applies = h => h.bs < bTo || (h.bs === bTo && h.be === bTo);
  while (i < hs.length && applies(hs[i])) {
    const h = hs[i];
    while (b < h.bs) { lines.push(other[o]); b++; o++; }
    for (let x = h.os; x < h.oe; x++) lines.push(other[x]);
    b = h.be;
    o = h.oe;
    i++;
  }
  while (b < bTo) { lines.push(other[o]); b++; o++; }
  return { lines, nextO: o, nextI: i };
}

export function diff3(baseText, localText, serverText) {
  const B = String(baseText ?? '').split('\n');
  const L = String(localText ?? '').split('\n');
  const S = String(serverText ?? '').split('\n');
  const hL = hunks(B, L, lcsMatches(B, L));
  const hS = hunks(B, S, lcsMatches(B, S));
  const out = [];
  const conflicts = [];
  let bi = 0;
  let li = 0;
  let si = 0;
  let iL = 0;
  let iS = 0;
  while (bi < B.length || iL < hL.length || iS < hS.length) {
    const nextL = iL < hL.length ? hL[iL].bs : B.length;
    const nextS = iS < hS.length ? hS[iS].bs : B.length;
    const stableEnd = Math.min(nextL, nextS);
    if (stableEnd > bi) {
      const count = stableEnd - bi;
      for (let k = 0; k < count; k++) out.push(B[bi + k]);
      bi += count; li += count; si += count;
      continue;
    }
    // Unstable region: seed with hunks starting exactly at bi, then extend
    // across strict overlaps only — adjacent (touching) edits on different
    // base lines stay separate regions and merge independently.
    let regionEnd = bi;
    let jL = iL;
    let jS = iS;
    while (jL < hL.length && hL[jL].bs === bi) {
      regionEnd = Math.max(regionEnd, hL[jL].be); jL++;
    }
    while (jS < hS.length && hS[jS].bs === bi) {
      regionEnd = Math.max(regionEnd, hS[jS].be); jS++;
    }
    for (;;) {
      let extended = false;
      while (jL < hL.length && hL[jL].bs < regionEnd) {
        regionEnd = Math.max(regionEnd, hL[jL].be); jL++; extended = true;
      }
      while (jS < hS.length && hS[jS].bs < regionEnd) {
        regionEnd = Math.max(regionEnd, hS[jS].be); jS++; extended = true;
      }
      if (!extended) break;
    }
    const baseSlice = B.slice(bi, regionEnd);
    const localSide = extract(hL, iL, L, bi, regionEnd, li);
    const serverSide = extract(hS, iS, S, bi, regionEnd, si);
    const baseJoined = baseSlice.join('\n');
    const localJoined = localSide.lines.join('\n');
    const serverJoined = serverSide.lines.join('\n');
    if (localJoined === serverJoined || serverJoined === baseJoined) {
      out.push(...localSide.lines);
    } else if (localJoined === baseJoined) {
      out.push(...serverSide.lines);
    } else {
      out.push('<<<<<<< LOCAL', ...localSide.lines, '=======', ...serverSide.lines, '>>>>>>> SERVER');
      conflicts.push({ base: baseJoined, local: localJoined, server: serverJoined });
    }
    bi = regionEnd;
    li = localSide.nextO;
    si = serverSide.nextO;
    iL = localSide.nextI;
    iS = serverSide.nextI;
  }
  return { clean: conflicts.length === 0, merged: out.join('\n'), conflicts };
}