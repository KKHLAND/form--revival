/* ============================================================
 * 양식 되살리기 엔진
 *  - PDF(텍스트) 좌표 기반 표·문단 복원
 *  - AI(이미지) 인식 결과(JSON) → 레이아웃
 *  - 레이아웃 → hwpx (한글 기본 빈 문서 골격 위에 서식 생성)
 *  - 읽을 수 있는 hwpx의 편집 잠금 속성 해제
 * 단위: 레이아웃은 pt(1/72인치, 좌상단 원점), hwpx는 HWPUNIT(1pt = 100)
 * 브라우저/Node 공용 (pdfjsLib, JSZip 은 인자로 받음)
 * ============================================================ */
(function (root) {
  'use strict';

  const PT2HU = 100;
  const MM2PT = 72 / 25.4;
  const LINE_WIDTHS = [0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0];
  const snapWidth = (mm) => LINE_WIDTHS.reduce((a, b) => (Math.abs(b - mm) < Math.abs(a - mm) ? b : a));
  /* ───────────── 한글(Hancom) 글자 폭 규칙 ─────────────
   * 한글 프로그램은 글자를 1/1800인치(4 HWPUNIT) 단위로 배치: em = floor(높이/4),
   * 글자 폭 = round(설계폭 × em / upem), 자간 = round(폭 × 자간% / 100), 빈칸 = em/2 */
  let METRICS = /*__METRICS__*/null;
  // Node에서 src/engine.js 를 직접 쓸 때는 옆의 글꼴 폭 표를 읽음
  if (!METRICS && typeof require === 'function') { try { METRICS = require('./font-metrics.json'); } catch (e) { /* 없으면 평균 폭 사용 */ } }
  const ADV_EM = { hangul: 1.0, wide: 1.0, upper: 0.7, lower: 0.52, digit: 0.55, space: 0.32, punct: 0.42, other: 0.62 };
  const faceCache = new Map();
  function faceTable(face) {
    if (!METRICS) return null;
    if (faceCache.has(face)) return faceCache.get(face);
    const f = METRICS.F[face];
    let t = null;
    if (f) {
      const map = new Map();
      [...METRICS.G].forEach((ch, i) => map.set(ch, f.g[i]));
      for (const [u, chars] of Object.entries(f.x)) for (const ch of chars) if (!map.has(ch)) map.set(ch, +u);
      t = { u: f.u, h: f.h, map };
    }
    faceCache.set(face, t);
    return t;
  }
  function classOf(ch) {
    const c = ch.codePointAt(0);
    if (ch === ' ' || ch === '\t') return 'space';
    if ((c >= 0xAC00 && c <= 0xD7A3) || (c >= 0x1100 && c <= 0x11FF) || (c >= 0x3130 && c <= 0x318F)) return 'hangul';
    if (c >= 0x4E00 && c <= 0x9FFF) return 'wide';
    if (/[A-Z]/.test(ch)) return 'upper';
    if (/[a-z]/.test(ch)) return 'lower';
    if (/[0-9]/.test(ch)) return 'digit';
    if (/[!-/:-@[-`{-~]/.test(ch)) return 'punct';
    if ((c >= 0x2000 && c <= 0x2BFF) || (c >= 0x3000 && c <= 0x33FF) || (c >= 0xFF00 && c <= 0xFFEF)) return 'wide';
    return 'other';
  }
  const roundAway = (v) => (v >= 0 ? Math.floor(v + 0.5) : -Math.floor(-v + 0.5));
  /** 한 줄 글자 폭(HWPUNIT) — runs: [{t,size,font}], sp: 자간 % */
  function hwpWidth(runs, sp) {
    let w = 0;
    for (const r of runs) {
      const height = clamp(Math.round((r.size || 10) * 2) * 50, 100, 409600);
      const em = Math.floor(height / 4);
      const ft = faceTable(r.font || '함초롬돋움') || faceTable('함초롬돋움');
      for (const ch of r.t) {
        let adv;
        if (ch === ' ' || ch === '\u00a0') adv = Math.floor(em / 2);
        else if (ft) {
          const cls = classOf(ch);
          const units = cls === 'hangul' ? ft.h : ft.map.get(ch);
          adv = units !== undefined ? Math.floor((units * em) / ft.u + 0.5) : null;
          if (adv === null) { w += ADV_EM[cls] * height * (1 + sp / 100); continue; }
        } else { w += ADV_EM[classOf(ch)] * height * (1 + sp / 100); continue; }
        w += (adv + roundAway((adv * sp) / 100)) * 4;
      }
    }
    return w;
  }
  /** 원본 줄 폭(target, pt)에 맞는 자간을 찾고, 칸 폭(avail, pt)을 넘지 않게 조정 */
  function fitSpacing(runs, targetPt, availPt) {
    if (!runs.length || !runs.some((r) => r.t.trim())) return 0;
    const solve = (goalHU) => {
      let lo = -50, hi = 30;
      if (hwpWidth(runs, lo) > goalHU) return -50;
      for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; if (hwpWidth(runs, mid) > goalHU) hi = mid; else lo = mid; }
      return Math.floor(lo);
    };
    let sp = targetPt > 0 ? solve(targetPt * PT2HU) : 0;
    if (Math.abs(sp) < 2) sp = 0;
    if (availPt > 0) {
      const lim = availPt * PT2HU * 0.985;
      if (hwpWidth(runs, sp) > lim) sp = Math.min(sp, solve(lim));
    }
    return clamp(sp, -50, 30);
  }
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const r0 = (v) => Math.round(v);

  /* ───────────── 글꼴 이름 정리 ───────────── */
  const FONT_MAP = [
    [/hcr\s*batang|hamchorom\s*batang|함초롬바탕|hcrbatang/i, '함초롬바탕'],
    [/hcr\s*dotum|hamchorom\s*dotum|함초롬돋움|hcrdotum/i, '함초롬돋움'],
    [/malgun|맑은\s*고딕/i, '맑은 고딕'],
    [/nanum\s*gothic|나눔고딕/i, '나눔고딕'],
    [/nanum\s*myeongjo|나눔명조/i, '나눔명조'],
    [/nanum\s*square|나눔스퀘어/i, '나눔스퀘어'],
    [/hy\s*headline|hy헤드라인/i, 'HY헤드라인M'],
    [/hy\s*gothic|hy\s*중고딕|hygothic/i, 'HY중고딕'],
    [/hy\s*gyeonmyeongjo|hy견명조/i, 'HY견명조'],
    [/gulimche|굴림체/i, '굴림체'],
    [/gulim|굴림/i, '굴림'],
    [/dotumche|돋움체/i, '돋움체'],
    [/dotum|돋움/i, '돋움'],
    [/batangche|바탕체/i, '바탕체'],
    [/batang|바탕/i, '바탕'],
    [/gungsuh|궁서/i, '궁서'],
    [/noto\s*sans\s*(cjk|kr)/i, '함초롬돋움'],
    [/noto\s*serif\s*(cjk|kr)/i, '함초롬바탕'],
    [/myeongjo|명조|serif|times|mincho|song/i, '함초롬바탕'],
  ];
  function normalizeFont(name) {
    const n = String(name || '').replace(/^[A-Z]{6}\+/, '');
    for (const [re, face] of FONT_MAP) if (re.test(n)) return face;
    if (/^serif$/i.test(n)) return '함초롬바탕';
    if (/headline|헤드라인/i.test(n)) return 'HY헤드라인M';
    return '함초롬돋움';
  }
  const isBoldName = (n) => /bold|black|heavy|extrabold|semibold|demibold|[-_ ]b$|bd$/i.test(String(n || '').replace(/^[A-Z]{6}\+/, ''));
  const isItalicName = (n) => /italic|oblique/i.test(String(n || ''));

  /* ───────────── 공통: 1차원 군집 ───────────── */
  function cluster(values, tol) {
    const v = [...values].sort((a, b) => a - b);
    const groups = [];
    for (const x of v) {
      const g = groups[groups.length - 1];
      if (g && x - g.max <= tol) { g.items.push(x); g.max = x; } else groups.push({ items: [x], max: x });
    }
    return groups.map((g) => g.items.reduce((a, b) => a + b, 0) / g.items.length);
  }

  /* ============================================================
   * 1. PDF 페이지 추출 (pdf.js 3.x)
   * ============================================================ */
  async function extractPdfPage(page, pdfjsLib, opts = {}) {
    const OPS = pdfjsLib.OPS;
    const Util = pdfjsLib.Util;
    const vp = page.getViewport({ scale: 1 });
    const W = vp.width, H = vp.height;
    const opList = await page.getOperatorList();
    const tc = await page.getTextContent({ includeMarkedContent: false });

    // ── 선(segment)·채움 영역 수집 ──
    const hSegs = [], vSegs = [], shades = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    let lw = 1, fillColor = '#000000', strokeColor = '#000000';
    const stack = [];
    let path = { lines: [], rects: [] };
    const devM = () => Util.transform(vp.transform, ctm);
    const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    const toHex = (a) => {
      if (typeof a[0] === 'string') return a[0].toUpperCase();
      const h = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
      return ('#' + h(a[0]) + h(a[1]) + h(a[2])).toUpperCase();
    };
    const isWhite = (c) => { const n = parseInt(c.slice(1), 16); return ((n >> 16) & 255) > 245 && ((n >> 8) & 255) > 245 && (n & 255) > 245; };

    const diags = [];
    function addLine(x1, y1, x2, y2, width, color) {
      const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
      if (dy < 0.6 && dx >= dy) {
        const len = Math.abs(x2 - x1);
        if (len < 0.25) return;
        hSegs.push({ y: (y1 + y2) / 2, a: Math.min(x1, x2), b: Math.max(x1, x2), w: width, color, ink: len, n: 1 });
      } else if (dx < 0.6 && dy > dx) {
        const len = Math.abs(y2 - y1);
        if (len < 0.25) return;
        vSegs.push({ x: (x1 + x2) / 2, a: Math.min(y1, y2), b: Math.max(y1, y2), w: width, color, ink: len, n: 1 });
      } else if (Math.hypot(x2 - x1, y2 - y1) > 6) {
        diags.push({ x1, y1, x2, y2, w: width });
      }
    }
    function commit(mode) {
      const m = devM();
      const sw = lw * scaleOf(m) || 0.3;
      const P = (x, y) => Util.applyTransform([x, y], m);
      if (mode.stroke) {
        for (const r of path.rects) {
          const p = [P(r[0], r[1]), P(r[0] + r[2], r[1]), P(r[0] + r[2], r[1] + r[3]), P(r[0], r[1] + r[3])];
          for (let i = 0; i < 4; i++) addLine(p[i][0], p[i][1], p[(i + 1) % 4][0], p[(i + 1) % 4][1], sw, strokeColor);
        }
        for (const l of path.lines) { const a = P(l[0], l[1]), b = P(l[2], l[3]); addLine(a[0], a[1], b[0], b[1], sw, strokeColor); }
      }
      if (mode.fill) {
        const boxes = [];
        for (const r of path.rects) {
          const a = P(r[0], r[1]), b = P(r[0] + r[2], r[1] + r[3]);
          boxes.push([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
        }
        if (path.lines.length >= 3 && path.lines.every((l) => Math.abs(l[0] - l[2]) < 0.01 || Math.abs(l[1] - l[3]) < 0.01)) {
          const pts = path.lines.flatMap((l) => [P(l[0], l[1]), P(l[2], l[3])]);
          const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
          boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
        }
        for (const [x1, y1, x2, y2] of boxes) {
          const w = x2 - x1, h = y2 - y1;
          if (h <= 2.5 && w > 1.5) addLine(x1, (y1 + y2) / 2, x2, (y1 + y2) / 2, Math.max(h, 0.2), fillColor);
          else if (w <= 2.5 && h > 1.5) addLine((x1 + x2) / 2, y1, (x1 + x2) / 2, y2, Math.max(w, 0.2), fillColor);
          else if (w > 2.5 && h > 2.5 && !isWhite(fillColor)) shades.push({ x1, y1, x2, y2, color: fillColor });
        }
      }
      path = { lines: [], rects: [] };
    }

    const fnA = opList.fnArray, argA = opList.argsArray;
    for (let i = 0; i < fnA.length; i++) {
      const fn = fnA[i], args = argA[i];
      switch (fn) {
        case OPS.save: stack.push({ ctm: ctm.slice(), lw, fillColor, strokeColor }); break;
        case OPS.restore: { const s = stack.pop(); if (s) ({ ctm, lw, fillColor, strokeColor } = s); break; }
        case OPS.transform: ctm = Util.transform(ctm, args); break;
        case OPS.paintFormXObjectBegin:
          stack.push({ ctm: ctm.slice(), lw, fillColor, strokeColor });
          if (args && Array.isArray(args[0]) && args[0].length === 6) ctm = Util.transform(ctm, args[0]);
          break;
        case OPS.paintFormXObjectEnd: { const s = stack.pop(); if (s) ({ ctm, lw, fillColor, strokeColor } = s); break; }
        case OPS.setLineWidth: lw = args[0]; break;
        case OPS.setFillRGBColor: fillColor = toHex(args); break;
        case OPS.setStrokeRGBColor: strokeColor = toHex(args); break;
        case OPS.setFillGray: fillColor = toHex([args[0] * 255, args[0] * 255, args[0] * 255]); break;
        case OPS.setStrokeGray: strokeColor = toHex([args[0] * 255, args[0] * 255, args[0] * 255]); break;
        case OPS.constructPath: {
          const ops = args[0], co = args[1];
          let k = 0, cx = 0, cy = 0, sx = 0, sy = 0;
          for (const op of ops) {
            if (op === OPS.moveTo) { cx = sx = co[k++]; cy = sy = co[k++]; }
            else if (op === OPS.lineTo) { const x = co[k++], y = co[k++]; path.lines.push([cx, cy, x, y]); cx = x; cy = y; }
            else if (op === OPS.rectangle) { path.rects.push([co[k++], co[k++], co[k++], co[k++]]); }
            else if (op === OPS.curveTo) { k += 4; cx = co[k++]; cy = co[k++]; }
            else if (op === OPS.curveTo2 || op === OPS.curveTo3) { k += 2; cx = co[k++]; cy = co[k++]; }
            else if (op === OPS.closePath) { if (cx !== sx || cy !== sy) path.lines.push([cx, cy, sx, sy]); cx = sx; cy = sy; }
          }
          break;
        }
        case OPS.stroke: case OPS.closeStroke: commit({ stroke: true }); break;
        case OPS.fill: case OPS.eoFill: commit({ fill: true }); break;
        case OPS.fillStroke: case OPS.eoFillStroke: case OPS.closeFillStroke: case OPS.closeEOFillStroke: commit({ fill: true, stroke: true }); break;
        case OPS.endPath: path = { lines: [], rects: [] }; break;
        default: break;
      }
    }

    // ── 글자 수집 ──
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const m = Util.transform(vp.transform, it.transform);
      const size = Math.hypot(m[2], m[3]) || Math.hypot(m[0], m[1]);
      if (size < 1) continue;
      // 세로쓰기·회전 글자는 건너뜀
      if (Math.abs(m[1]) > Math.abs(m[0]) * 0.5) continue;
      let fontName = '', bold = false, italic = false;
      try {
        const f = page.commonObjs.has(it.fontName) ? page.commonObjs.get(it.fontName) : null;
        fontName = (f && (f.name || f.loadedName)) || '';
        bold = !!(f && (f.bold || f.black)) || isBoldName(fontName);
        italic = !!(f && f.italic) || isItalicName(fontName);
      } catch (e) { /* 무시 */ }
      const family = (tc.styles && tc.styles[it.fontName] && tc.styles[it.fontName].fontFamily) || '';
      const w = it.width * (vp.scale || 1);
      const iw = w > 0 ? w : it.str.length * size * 0.5;
      let color = '#000000';
      if (opts.sampleColor) { try { color = opts.sampleColor(m[4], m[5] - size * 0.8, m[4] + iw, m[5] + size * 0.1) || '#000000'; } catch (e) { /* 무시 */ } }
      items.push({ str: it.str, x: m[4], y: m[5], w: iw, size, bold, italic, color, font: normalizeFont(fontName || family) });
    }
    // 겹쳐 찍은 굵은 글씨 중복 제거
    items.sort((a, b) => a.y - b.y || a.x - b.x);
    const dedup = [];
    for (const it of items) {
      const d = dedup.find((o) => o.str === it.str && Math.abs(o.x - it.x) < 1.2 && Math.abs(o.y - it.y) < 1.2);
      if (d) d.bold = true; else dedup.push(it);
    }

    const layout = buildLayoutFromPrimitives({ W, H, items: dedup, hSegs, vSegs, shades, diags });
    layout.textChars = dedup.reduce((n, i) => n + i.str.trim().length, 0);
    layout.lineCount = hSegs.length + vSegs.length;
    return layout;
  }

  /* ── 선 병합 ── */
  function mergeSegs(segs, key) {
    const groups = new Map();
    const sorted = [...segs].sort((a, b) => a[key] - b[key]);
    const out = [];
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      cur.sort((a, b) => a.a - b.a);
      let s = { ...cur[0] };
      for (let i = 1; i < cur.length; i++) {
        const t = cur[i];
        const sShort = s.ink / s.n < 3, tShort = t.ink < 3;
        const ok = sShort === tShort ? t.a <= s.b + (tShort ? 2.6 : 1.5) : t.a < s.b - 0.3;
        if (ok) { s.b = Math.max(s.b, t.b); s.w = Math.max(s.w, t.w); s[key] = (s[key] + t[key]) / 2; s.ink += t.ink; s.n += t.n; }
        else { out.push(s); s = { ...t }; }
      }
      out.push(s);
      cur = [];
    };
    for (const sg of sorted) {
      if (cur.length && sg[key] - cur[cur.length - 1][key] > 0.7) flush();
      cur.push(sg);
    }
    flush();
    void groups;
    for (const s of out) {
      const span = s.b - s.a;
      s.dot = s.n >= 4 && s.ink / span < 0.8 ? (s.ink / s.n < 1.6 ? 'DOT' : 'DASH') : '';
    }
    return out.filter((s) => s.b - s.a >= 1.5);
  }

  /* ── 표 찾기 + 글자 배치 → 레이아웃 ── */
  function buildLayoutFromPrimitives({ W, H, items, hSegs, vSegs, shades, diags = [] }) {
    const hs = mergeSegs(hSegs, 'y');
    const vs = mergeSegs(vSegs, 'x');
    const tol = 2.2;
    // union-find: 가로·세로가 만나면 같은 표
    const n = hs.length + vs.length;
    const par = Array.from({ length: n }, (_, i) => i);
    const find = (i) => (par[i] === i ? i : (par[i] = find(par[i])));
    const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) par[a] = b; };
    hs.forEach((h, i) => vs.forEach((v, j) => {
      if (v.x >= h.a - tol && v.x <= h.b + tol && h.y >= v.a - tol && h.y <= v.b + tol) uni(i, hs.length + j);
    }));
    const comps = new Map();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      if (!comps.has(r)) comps.set(r, { h: [], v: [] });
      if (i < hs.length) comps.get(r).h.push(hs[i]); else comps.get(r).v.push(vs[i - hs.length]);
    }
    const tables = [];
    for (const c of comps.values()) {
      if (c.h.length < 2 || c.v.length < 2) continue;
      const t = buildTable(c.h, c.v, shades, diags);
      if (!t) continue;
      // 페이지 전체 테두리(1칸짜리 큰 상자)는 표로 보지 않음
      if (t.rowH.length === 1 && t.colW.length === 1 && (t.x2 - t.x1) * (t.bottom - t.top) > W * H * 0.45) continue;
      tables.push(t);
    }
    // 큰 표 안에 들어간 작은 표(중첩)는 제거
    const inside = (a, b) => a !== b && a.x1 >= b.x1 - 1 && a.x2 <= b.x2 + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
    const finalTables = tables.filter((t) => !tables.some((o) => inside(t, o)));

    // 글자 → 셀 / 본문
    const free = [];
    for (const it of items) {
      const cx = it.x + it.w / 2, cy = it.y - it.size * 0.35;
      let placed = false;
      for (const t of finalTables) {
        if (cx < t.x1 || cx > t.x2 || cy < t.top || cy > t.bottom) continue;
        const cell = t.cells.find((c) => cx >= c._x1 && cx <= c._x2 && cy >= c._y1 && cy <= c._y2);
        if (cell) { cell._items.push(it); placed = true; break; }
      }
      if (!placed) free.push(it);
    }
    for (const t of finalTables) {
      for (const c of t.cells) {
        const lines = groupLines(c._items);
        c.paras = lines.map((ln, i) => {
          const gl = ln.x1 - c._x1, gr = c._x2 - ln.x2, w = c._x2 - c._x1;
          let align = 'LEFT', indent = 0;
          if (Math.abs(gl - gr) <= Math.max(3, w * 0.08)) align = 'CENTER';
          else if (gl < gr) { align = 'LEFT'; indent = Math.max(0, gl - 1.6); }
          else align = 'RIGHT';
          const next = lines[i + 1];
          let ls = 130;
          if (next) ls = clamp(((next.y - ln.y) / ln.size) * 100, 100, 300);
          else if (lines.length > 1) ls = clamp(((ln.y - lines[i - 1].y) / ln.size) * 100, 100, 300);
          const sp = fitSpacing(ln.runs, ln.x2 - ln.x1, w - 2 * 1.41 - indent);
          if (sp) for (const r of ln.runs) r.sp = sp;
          // 마지막 줄은 줄 간격이 칸 높이만 늘리므로 100%
          return { align, indent, ls: next ? r0(ls) : 100, runs: ln.runs, oneLine: true };
        });
        if (lines.length) {
          const top = lines[0].y - lines[0].size * 0.85, bot = lines[lines.length - 1].y + lines[lines.length - 1].size * 0.2;
          const tg = top - c._y1, bg = c._y2 - bot, h = c._y2 - c._y1;
          c.va = Math.abs(tg - bg) <= Math.max(3, h * 0.2) ? 'CENTER' : tg < bg ? 'TOP' : 'BOTTOM';
        } else c.va = 'CENTER';
        delete c._items;
      }
    }

    // 본문 줄
    const lines = groupLines(free);
    const blocks = [];
    lines.forEach((ln, i) => {
      const next = lines[i + 1];
      let ls = 160;
      if (next && Math.abs(next.size - ln.size) < 0.6 && next.y - ln.y < ln.size * 2.6 && next.y - ln.y > ln.size * 0.9)
        ls = clamp(((next.y - ln.y) / ln.size) * 100, 100, 260);
      const sp = fitSpacing(ln.runs, ln.x2 - ln.x1, W - ln.x1 - 14);
      if (sp) for (const r of ln.runs) r.sp = sp;
      blocks.push({ kind: 'p', top: ln.y - ln.size * 0.85, x1: ln.x1, x2: ln.x2, size: ln.size, ls: r0(ls), runs: ln.runs, oneLine: true });
    });
    for (const t of finalTables) blocks.push(t);
    blocks.sort((a, b) => a.top - b.top || a.x1 - b.x1);
    return finalizeLayout({ W, H, blocks });
  }

  function buildTable(H, V, shades, diags = []) {
    const ys0 = cluster(H.map((h) => h.y), 1.2);
    const xs0 = cluster(V.map((v) => v.x), 1.2);
    // 이중선: 3pt 이내로 붙은 선 묶기
    const mergeClose = (arr) => { const o = []; for (const v of arr) { if (o.length && v - o[o.length - 1] < 3) o[o.length - 1] = (o[o.length - 1] + v) / 2; else o.push(v); } return o; };
    const ys = mergeClose(ys0), xs = mergeClose(xs0);
    if (ys.length < 2 || xs.length < 2) return null;
    const R = ys.length - 1, C = xs.length - 1;
    const near = 2.6;
    const cover = (segs, pos, key, a, b) => {
      const hits = segs.filter((s) => Math.abs(s[key] - pos) <= near && s.b > a + 0.5 && s.a < b - 0.5);
      let len = 0;
      const iv = hits.map((s) => [Math.max(a, s.a), Math.min(b, s.b)]).sort((p, q) => p[0] - q[0]);
      let ca = -1e9, cb = -1e9;
      for (const [p, q] of iv) { if (p > cb) { len += cb - ca > 0 ? cb - ca : 0; ca = p; cb = q; } else cb = Math.max(cb, q); }
      len += cb - ca > 0 ? cb - ca : 0;
      return { ratio: (b - a) > 0 ? len / (b - a) : 0, hits };
    };
    const vB = (i, j) => cover(V, xs[j], 'x', ys[i], ys[i + 1]); // 세로선: 행 i, x 경계 j
    const hB = (i, j) => cover(H, ys[i], 'y', xs[j], xs[j + 1]); // 가로선: y 경계 i, 열 j
    const has = (o) => o.ratio >= 0.55;

    const owner = Array.from({ length: R }, () => Array(C).fill(-1));
    const cells = [];
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      if (owner[r][c] >= 0) continue;
      let cs = 1;
      while (c + cs < C && owner[r][c + cs] < 0 && !has(vB(r, c + cs))) cs++;
      let rs = 1;
      outer: while (r + rs < R) {
        for (let k = 0; k < cs; k++) { if (owner[r + rs][c + k] >= 0 || has(hB(r + rs, c + k))) break outer; }
        for (let k = 1; k < cs; k++) if (has(vB(r + rs, c + k))) break outer;
        rs++;
      }
      const id = cells.length;
      for (let a = 0; a < rs; a++) for (let b = 0; b < cs; b++) owner[r + a][c + b] = id;
      cells.push({ r, c, rs, cs });
    }
    const side = (list) => {
      const hits = list.flatMap((o) => o.hits);
      const covered = list.some(has) || list.reduce((s, o) => s + o.ratio, 0) / list.length > 0.4;
      if (!covered || !hits.length) return { type: 'NONE', w: 0.12 };
      const pos = cluster(hits.map((h) => (h.y !== undefined ? h.y : h.x)), 0.5);
      const w = Math.max(...hits.map((h) => h.w));
      if (pos.length >= 2 && pos[pos.length - 1] - pos[0] > 0.8) return { type: 'DOUBLE_SLIM', w: snapWidth(w * 0.3528) };
      const dotted = hits.filter((h) => h.dot);
      if (dotted.length * 2 >= hits.length) return { type: dotted[0].dot, w: snapWidth(w * 0.3528) };
      return { type: 'SOLID', w: snapWidth(w * 0.3528) };
    };
    for (const cell of cells) {
      const { r, c, rs, cs } = cell;
      cell._x1 = xs[c]; cell._x2 = xs[c + cs]; cell._y1 = ys[r]; cell._y2 = ys[r + rs];
      cell.b = {
        l: side(Array.from({ length: rs }, (_, k) => vB(r + k, c))),
        r: side(Array.from({ length: rs }, (_, k) => vB(r + k, c + cs))),
        t: side(Array.from({ length: cs }, (_, k) => hB(r, c + k))),
        bm: side(Array.from({ length: cs }, (_, k) => hB(r + rs, c + k))),
      };
      const area = (cell._x2 - cell._x1) * (cell._y2 - cell._y1);
      for (const s of shades) {
        const ix = Math.min(s.x2, cell._x2) - Math.max(s.x1, cell._x1), iy = Math.min(s.y2, cell._y2) - Math.max(s.y1, cell._y1);
        if (ix > 0 && iy > 0 && ix * iy > area * 0.5) cell.bg = s.color;
      }
      const cw = cell._x2 - cell._x1, ch = cell._y2 - cell._y1, tl = Math.max(2.5, Math.min(cw, ch) * 0.12);
      const at = (x, y, px, py) => Math.abs(x - px) <= tl && Math.abs(y - py) <= tl;
      for (const d of diags) {
        const ends = [[d.x1, d.y1], [d.x2, d.y2]];
        const hasEnd = (px, py) => ends.some(([x, y]) => at(x, y, px, py));
        if (hasEnd(cell._x1, cell._y1) && hasEnd(cell._x2, cell._y2)) cell.diag = { kind: 'back', w: snapWidth(d.w * 0.3528) };
        else if (hasEnd(cell._x1, cell._y2) && hasEnd(cell._x2, cell._y1)) cell.diag = { kind: 'slash', w: snapWidth(d.w * 0.3528) };
      }
      cell._items = [];
    }
    const t = {
      kind: 't', top: ys[0], bottom: ys[R], x1: xs[0], x2: xs[C],
      colW: xs.slice(1).map((x, i) => x - xs[i]), rowH: ys.slice(1).map((y, i) => y - ys[i]), cells,
    };
    normalizeTable(t);
    return t;
  }

  /** 시작 셀이 없는 행/열 제거 (한글이 표를 거부하지 않도록) */
  function normalizeTable(t) {
    for (let i = t.rowH.length - 1; i >= 0; i--) {
      if (t.cells.some((c) => c.r === i)) continue;
      for (const c of t.cells) { if (c.r < i && c.r + c.rs > i) c.rs--; else if (c.r > i) c.r--; }
      if (i > 0) t.rowH[i - 1] += t.rowH[i]; else if (t.rowH.length > 1) t.rowH[1] += t.rowH[0];
      t.rowH.splice(i, 1);
    }
    for (let j = t.colW.length - 1; j >= 0; j--) {
      if (t.cells.some((c) => c.c === j)) continue;
      for (const c of t.cells) { if (c.c < j && c.c + c.cs > j) c.cs--; else if (c.c > j) c.c--; }
      if (j > 0) t.colW[j - 1] += t.colW[j]; else if (t.colW.length > 1) t.colW[1] += t.colW[0];
      t.colW.splice(j, 1);
    }
  }

  /** 글자 조각 → 줄(runs 포함) */
  function groupLines(items) {
    const its = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const it of its) {
      const ln = lines.find((l) => Math.abs(l.y - it.y) < Math.min(l.size, it.size) * 0.4);
      if (ln) { ln.items.push(it); ln.size = Math.max(ln.size, it.size); }
      else lines.push({ y: it.y, size: it.size, items: [it] });
    }
    for (const ln of lines) {
      ln.items.sort((a, b) => a.x - b.x);
      ln.x1 = ln.items[0].x;
      ln.x2 = Math.max(...ln.items.map((i) => i.x + i.w));
      ln.y = ln.items.reduce((s, i) => s + i.y * i.size, 0) / ln.items.reduce((s, i) => s + i.size, 0);
      const runs = [];
      let prevEnd = null;
      for (const it of ln.items) {
        let text = it.str;
        if (prevEnd !== null) {
          const gap = it.x - prevEnd;
          const last = runs[runs.length - 1];
          const endsSpace = last && /\s$/.test(last.t);
          if (gap > it.size * 0.18 && !endsSpace && !/^\s/.test(text)) {
            const cnt = clamp(Math.round(gap / (it.size * 0.5)), 1, 60);
            text = ' '.repeat(cnt) + text;
          }
        }
        const st = { size: Math.round(it.size * 2) / 2, bold: it.bold, italic: it.italic, font: it.font, color: it.color || '#000000' };
        const last = runs[runs.length - 1];
        if (last && last.size === st.size && last.bold === st.bold && last.italic === st.italic && last.font === st.font && last.color === st.color) last.t += text;
        else runs.push({ t: text, ...st });
        prevEnd = it.x + it.w;
      }
      ln.runs = runs;
    }
    lines.sort((a, b) => a.y - b.y);
    return lines;
  }

  /** 페이지 여백 계산 */
  function finalizeLayout({ W, H, blocks }) {
    let minX = W, maxX = 0, minY = H, maxY = 0;
    for (const b of blocks) {
      minX = Math.min(minX, b.x1); maxX = Math.max(maxX, b.x2);
      minY = Math.min(minY, b.top);
      maxY = Math.max(maxY, b.kind === 't' ? b.bottom : b.top + b.size * 1.2);
    }
    if (!blocks.length) { minX = 56; maxX = W - 56; minY = 56; maxY = H - 56; }
    const ml = clamp(minX - 1, 8, W / 3), mr = clamp(W - maxX - 1, 8, W / 3);
    const mt = clamp(minY - 1, 8, H / 3);
    const mb = clamp(Math.min(H - maxY, 42), 8, H / 3);
    return { W, H, margin: { l: ml, r: mr, t: mt, b: mb }, blocks };
  }

  /* ============================================================
   * 2. AI 인식 결과(JSON) → 레이아웃
   * ============================================================ */
  const AI_PROMPT = `당신은 한국 학교·공공기관 문서 양식을 한글(HWP) 편집 문서로 복원하는 조판 전문가입니다.
첨부 이미지는 문서 한 페이지입니다. 원본과 최대한 똑같이 다시 조판할 수 있도록 페이지의 모든 요소를 위에서 아래 순서로 JSON으로 기술하세요.

규칙
- 좌표·크기는 모두 mm(페이지 좌상단 원점). 페이지 크기는 실제 용지 기준(A4 세로면 210×297)으로 추정.
- 글자는 원본 그대로 한 글자도 빠짐없이 옮기고, 맞춤법을 고치지 마세요. 빈 칸(작성란)은 빈 문자열 "".
- 표는 격자 전체를 기술: colWidthsMm(열 너비들), rowHeightsMm(행 높이들), cells(왼쪽 위 칸 기준 row/col, 병합은 rowSpan/colSpan). 모든 격자 칸이 정확히 한 셀에 속해야 합니다.
- 셀 테두리가 없는 면은 borders에 "none", 굵은 선은 "thick", 이중선은 "double", 점선은 "dotted", 파선은 "dashed", 그 외 "solid".
- 셀 배경색이 있으면 bg에 #RRGGBB. 검정이 아닌 글자색은 color에 #RRGGBB. 셀 안 줄바꿈은 \\n.
- 대각선이 그어진 칸(예: 왼쪽 위 머리칸)은 diagonal에 "down"(왼쪽 위→오른쪽 아래) 또는 "up".
- 표가 아닌 글은 paragraph로, 한 줄씩 나누지 말고 원본의 문단 단위로. 여러 줄이면 \\n으로 줄 위치 유지.
- font: "serif"(바탕·명조), "sans"(돋움·고딕), "headline"(굵은 제목체) 중 하나.
- 서명란, 결재란, 체크박스(□), 원문자 등 기호도 그대로.

출력(JSON만):
{"page":{"widthMm":210,"heightMm":297},
 "blocks":[
  {"type":"paragraph","yMm":20,"xMm":20,"widthMm":170,"align":"left|center|right|justify","fontSizePt":10,"bold":false,"underline":false,"font":"sans","lineSpacing":160,"text":"..."},
  {"type":"table","yMm":40,"xMm":20,"colWidthsMm":[30,140],"rowHeightsMm":[8,8],
   "cells":[{"row":0,"col":0,"rowSpan":1,"colSpan":1,"text":"","align":"center","vAlign":"middle","fontSizePt":10,"bold":false,"font":"sans","bg":null,"color":null,"diagonal":null,
             "borders":{"top":"solid","bottom":"solid","left":"solid","right":"solid"}}]}
 ]}`;

  function aiToLayout(json, fallbackPageMm) {
    const page = (json && json.page) || {};
    const Wmm = Number(page.widthMm) || (fallbackPageMm && fallbackPageMm.w) || 210;
    const Hmm = Number(page.heightMm) || (fallbackPageMm && fallbackPageMm.h) || 297;
    const W = Wmm * MM2PT, H = Hmm * MM2PT;
    const hexOf = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c.toUpperCase() : '#000000');
    const fontOf = (f) => (f === 'serif' ? '함초롬바탕' : f === 'headline' ? 'HY헤드라인M' : '함초롬돋움');
    const alignOf = (a) => ({ left: 'LEFT', center: 'CENTER', right: 'RIGHT', justify: 'JUSTIFY' }[String(a || '').toLowerCase()] || 'LEFT');
    const vaOf = (a) => ({ top: 'TOP', middle: 'CENTER', center: 'CENTER', bottom: 'BOTTOM' }[String(a || '').toLowerCase()] || 'CENTER');
    const bOf = (s) => {
      s = String(s || 'solid').toLowerCase();
      if (s === 'none') return { type: 'NONE', w: 0.12 };
      if (s === 'thick') return { type: 'SOLID', w: 0.4 };
      if (s === 'double') return { type: 'DOUBLE_SLIM', w: 0.5 };
      if (s === 'dotted' || s === 'dot') return { type: 'DOT', w: 0.12 };
      if (s === 'dashed' || s === 'dash') return { type: 'DASH', w: 0.12 };
      return { type: 'SOLID', w: 0.12 };
    };
    const blocks = [];
    for (const b of (json && json.blocks) || []) {
      const x = (Number(b.xMm) || 20) * MM2PT, y = (Number(b.yMm) || 0) * MM2PT;
      if (b.type === 'table') {
        const colW = (b.colWidthsMm || []).map((v) => Math.max(1, Number(v) || 1) * MM2PT);
        const rowH = (b.rowHeightsMm || []).map((v) => Math.max(1, Number(v) || 1) * MM2PT);
        if (!colW.length || !rowH.length) continue;
        const R = rowH.length, C = colW.length;
        const owner = Array.from({ length: R }, () => Array(C).fill(false));
        const cells = [];
        for (const c of b.cells || []) {
          const r = clamp(c.row | 0, 0, R - 1), cc = clamp(c.col | 0, 0, C - 1);
          const rs = clamp(c.rowSpan | 0 || 1, 1, R - r), cs = clamp(c.colSpan | 0 || 1, 1, C - cc);
          let clash = false;
          for (let a = 0; a < rs; a++) for (let k = 0; k < cs; k++) if (owner[r + a][cc + k]) clash = true;
          if (clash) continue;
          for (let a = 0; a < rs; a++) for (let k = 0; k < cs; k++) owner[r + a][cc + k] = true;
          const size = Number(c.fontSizePt) || 10;
          const brd = c.borders || {};
          cells.push({
            r, c: cc, rs, cs, va: vaOf(c.vAlign), bg: /^#[0-9a-f]{6}$/i.test(c.bg || '') ? c.bg.toUpperCase() : undefined,
            b: { l: bOf(brd.left), r: bOf(brd.right), t: bOf(brd.top), bm: bOf(brd.bottom) },
            diag: c.diagonal === 'down' ? { kind: 'back', w: 0.12 } : c.diagonal === 'up' ? { kind: 'slash', w: 0.12 } : undefined,
            paras: String(c.text ?? '').split('\n').map((t) => ({ align: alignOf(c.align), indent: 0, ls: 130, runs: [{ t, size, bold: !!c.bold, font: fontOf(c.font), color: hexOf(c.color) }] })),
          });
        }
        // 빠진 격자 칸 채우기
        for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) if (!owner[r][c]) {
          owner[r][c] = true;
          cells.push({ r, c, rs: 1, cs: 1, va: 'CENTER', b: { l: bOf(), r: bOf(), t: bOf(), bm: bOf() }, paras: [{ align: 'LEFT', indent: 0, ls: 130, runs: [{ t: '', size: 10, font: '함초롬돋움' }] }] });
        }
        cells.sort((p, q) => p.r - q.r || p.c - q.c);
        const t = { kind: 't', top: y, x1: x, colW, rowH, cells };
        normalizeTable(t);
        t.x2 = x + t.colW.reduce((s, v) => s + v, 0);
        t.bottom = y + t.rowH.reduce((s, v) => s + v, 0);
        blocks.push(t);
      } else {
        const size = Number(b.fontSizePt) || 10;
        const ls = clamp(Number(b.lineSpacing) || 160, 100, 300);
        const lines = String(b.text ?? '').split('\n');
        const wpt = (Number(b.widthMm) || 0) * MM2PT;
        lines.forEach((t, i) => {
          blocks.push({
            kind: 'p', top: y + i * size * ls / 100, x1: x, x2: wpt ? x + wpt : x + t.length * size * 0.9, size, ls,
            alignHint: alignOf(b.align),
            runs: [{ t, size, bold: !!b.bold, underline: !!b.underline, font: fontOf(b.font), color: hexOf(b.color) }],
          });
        });
      }
    }
    blocks.sort((a, b) => a.top - b.top || a.x1 - b.x1);
    return finalizeLayout({ W, H, blocks });
  }

  /* ============================================================
   * 3. 레이아웃 → hwpx
   * ============================================================ */
  class HeaderBuilder {
    constructor(xml) {
      this.xml = xml;
      this.fonts = new Map();
      const hang = xml.match(/<hh:fontface lang="HANGUL"[\s\S]*?<\/hh:fontface>/)[0];
      for (const m of hang.matchAll(/<hh:font id="(\d+)" face="([^"]+)"/g)) this.fonts.set(m[2], +m[1]);
      this.fontNext = this.fonts.size;
      this.newFonts = [];
      this.bfNext = (xml.match(/<hh:borderFill id=/g) || []).length + 1;
      this.cpNext = (xml.match(/<hh:charPr id=/g) || []).length;
      this.ppNext = (xml.match(/<hh:paraPr id=/g) || []).length;
      this.bf = new Map(); this.cp = new Map(); this.pp = new Map();
      this.bfXml = []; this.cpXml = []; this.ppXml = [];
    }
    font(face) {
      if (this.fonts.has(face)) return this.fonts.get(face);
      const id = this.fontNext++;
      this.fonts.set(face, id);
      this.newFonts.push({ id, face });
      return id;
    }
    borderFill({ l, r, t, b, bg, diag }) {
      const key = JSON.stringify([l, r, t, b, bg || '', diag || '']);
      if (this.bf.has(key)) return this.bf.get(key);
      const id = this.bfNext++;
      const side = (n, s) => `<hh:${n} type="${s.type}" width="${s.type === 'NONE' ? '0.1' : Number.isInteger(s.w) ? s.w.toFixed(1) : String(s.w)} mm" color="#000000"/>`;
      const fill = bg ? `<hc:fillBrush><hc:winBrush faceColor="${bg}" hatchColor="#999999" alpha="0"/></hc:fillBrush>` : '';
      this.bfXml.push(`<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="${diag && diag.kind === 'slash' ? 'CENTER' : 'NONE'}" Crooked="0" isCounter="0"/><hh:backSlash type="${diag && diag.kind === 'back' ? 'CENTER' : 'NONE'}" Crooked="0" isCounter="0"/>${side('leftBorder', l)}${side('rightBorder', r)}${side('topBorder', t)}${side('bottomBorder', b)}${side('diagonal', diag ? { type: 'SOLID', w: diag.w } : { type: 'SOLID', w: 0.1 })}${fill}</hh:borderFill>`);
      this.bf.set(key, id);
      return id;
    }
    charPr({ size = 10, bold = false, italic = false, underline = false, font = '함초롬돋움', color = '#000000', sp = 0 }) {
      const h = clamp(Math.round(size * 2) * 50, 100, 409600);
      const fid = this.font(font);
      sp = clamp(Math.round(sp || 0), -50, 50);
      const key = [h, bold, italic, underline, fid, color, sp].join('|');
      if (this.cp.has(key)) return this.cp.get(key);
      const id = this.cpNext++;
      const all = (v) => ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'].map((k) => `${k}="${v}"`).join(' ');
      this.cpXml.push(`<hh:charPr id="${id}" height="${h}" textColor="${color}" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2"><hh:fontRef ${all(fid)}/><hh:ratio ${all(100)}/><hh:spacing ${all(sp)}/><hh:relSz ${all(100)}/><hh:offset ${all(0)}/>${italic ? '<hh:italic/>' : ''}${bold ? '<hh:bold/>' : ''}<hh:underline type="${underline ? 'BOTTOM' : 'NONE'}" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/><hh:outline type="NONE"/><hh:shadow type="NONE" color="#C0C0C0" offsetX="10" offsetY="10"/></hh:charPr>`);
      this.cp.set(key, id);
      return id;
    }
    paraPr({ align = 'LEFT', left = 0, indent = 0, prev = 0, next = 0, ls = 160, oneLine = false }) {
      left = r0(left); indent = r0(indent); prev = r0(Math.max(0, prev)); next = r0(Math.max(0, next)); ls = r0(ls);
      const key = [align, left, indent, prev, next, ls, oneLine].join('|');
      if (this.pp.has(key)) return this.pp.get(key);
      const id = this.ppNext++;
      const mg = (k) => `<hh:margin><hc:intent value="${indent * k}" unit="HWPUNIT"/><hc:left value="${left * k}" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="${prev * k}" unit="HWPUNIT"/><hc:next value="${next * k}" unit="HWPUNIT"/></hh:margin><hh:lineSpacing type="PERCENT" value="${ls}" unit="HWPUNIT"/>`;
      this.ppXml.push(`<hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="0" suppressLineNumbers="0" checked="0" textDir="LTR"><hh:align horizontal="${align}" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/><hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="BREAK_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="${oneLine ? 'SQUEEZE' : 'BREAK'}"/><hh:autoSpacing eAsianEng="0" eAsianNum="0"/><hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">${mg(1)}</hp:case><hp:default>${mg(2)}</hp:default></hp:switch><hh:border borderFillIDRef="2" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>`);
      this.pp.set(key, id);
      return id;
    }
    toXml() {
      let x = this.xml;
      if (this.newFonts.length) {
        x = x.replace(/<hh:fontface lang="([A-Z]+)" fontCnt="(\d+)">([\s\S]*?)<\/hh:fontface>/g, (m, lang, cnt, inner) => {
          const add = this.newFonts.map((f) => `<hh:font id="${f.id}" face="${esc(f.face)}" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/></hh:font>`).join('');
          return `<hh:fontface lang="${lang}" fontCnt="${+cnt + this.newFonts.length}">${inner}${add}</hh:fontface>`;
        });
      }
      const ins = (tag, items) => {
        if (!items.length) return;
        x = x.replace(`</hh:${tag}>`, items.join('') + `</hh:${tag}>`);
        x = x.replace(new RegExp(`<hh:${tag} itemCnt="(\\d+)"`), (m, n) => `<hh:${tag} itemCnt="${+n + items.length}"`);
      };
      ins('borderFills', this.bfXml);
      ins('charProperties', this.cpXml);
      ins('paraProperties', this.ppXml);
      return x;
    }
  }

  function buildSection(skeletonSec, layouts, hb) {
    const first = layouts[0] || { W: 595.3, H: 841.9, margin: { l: 56, r: 56, t: 56, b: 42 }, blocks: [] };
    // 여백: 모든 페이지 중 가장 좁은 값
    const mg = { l: Infinity, r: Infinity, t: Infinity, b: Infinity };
    for (const L of layouts) for (const k of 'lrtb') mg[k] = Math.min(mg[k], L.margin[k]);
    if (!layouts.length) Object.assign(mg, first.margin);
    const landscape = first.W > first.H;
    const pw = r0(Math.min(first.W, first.H) * PT2HU), ph = r0(Math.max(first.W, first.H) * PT2HU);
    let secPr = skeletonSec.match(/<hp:secPr[\s\S]*?<\/hp:secPr><hp:ctrl>[\s\S]*?<\/hp:ctrl>/)[0];
    secPr = secPr.replace(/<hp:pagePr [^>]*>/, `<hp:pagePr landscape="${landscape ? 'NARROWLY' : 'WIDELY'}" width="${pw}" height="${ph}" gutterType="LEFT_ONLY">`)
      .replace(/<hp:margin header="\d+" footer="\d+" gutter="\d+" left="\d+" right="\d+" top="\d+" bottom="\d+"\/>/,
        `<hp:margin header="0" footer="0" gutter="0" left="${r0(mg.l * PT2HU)}" right="${r0(mg.r * PT2HU)}" top="${r0(mg.t * PT2HU)}" bottom="${r0(mg.b * PT2HU)}"/>`);
    const rootOpen = skeletonSec.match(/<hs:sec [^>]*>/)[0];
    const contentW = first.W - mg.l - mg.r;
    let tblId = 1000000001, z = 0;

    const runXml = (runs) => runs.map((r) => {
      const id = hb.charPr(r);
      return r.t ? `<hp:run charPrIDRef="${id}"><hp:t>${esc(r.t)}</hp:t></hp:run>` : `<hp:run charPrIDRef="${id}"/>`;
    }).join('');

    const cellPara = (p) => {
      const pp = hb.paraPr({ align: p.align || 'LEFT', left: (p.indent || 0) * PT2HU, ls: p.ls || 130, oneLine: !!p.oneLine });
      const runs = p.runs && p.runs.length ? p.runs : [{ t: '', size: 10 }];
      return `<hp:p id="0" paraPrIDRef="${pp}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${runXml(runs)}</hp:p>`;
    };

    const tableXml = (t) => {
      const colW = t.colW.map((v) => Math.max(200, r0(v * PT2HU)));
      const rowH = t.rowH.map((v) => Math.max(200, r0(v * PT2HU)));
      const Wt = colW.reduce((a, b) => a + b, 0), Ht = rowH.reduce((a, b) => a + b, 0);
      const rows = rowH.map(() => []);
      for (const c of t.cells) rows[c.r].push(c);
      const trs = rows.map((cells) => `<hp:tr>${cells.sort((a, b) => a.c - b.c).map((c) => {
        const w = colW.slice(c.c, c.c + c.cs).reduce((a, b) => a + b, 0);
        const h = rowH.slice(c.r, c.r + c.rs).reduce((a, b) => a + b, 0);
        const bf = hb.borderFill({ l: c.b.l, r: c.b.r, t: c.b.t, b: c.b.bm, bg: c.bg, diag: c.diag });
        const paras = (c.paras && c.paras.length ? c.paras : [{ align: 'LEFT', runs: [{ t: '', size: 10 }] }]).map(cellPara).join('');
        return `<hp:tc name="" header="0" hasMargin="1" protect="0" editable="0" dirty="0" borderFillIDRef="${bf}"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${c.va || 'CENTER'}" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${paras}</hp:subList><hp:cellAddr colAddr="${c.c}" rowAddr="${c.r}"/><hp:cellSpan colSpan="${c.cs}" rowSpan="${c.rs}"/><hp:cellSz width="${w}" height="${h}"/><hp:cellMargin left="141" right="141" top="57" bottom="57"/></hp:tc>`;
      }).join('')}</hp:tr>`).join('');
      return `<hp:tbl id="${tblId++}" zOrder="${z++}" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="${rowH.length}" colCnt="${colW.length}" cellSpacing="0" borderFillIDRef="1" noAdjust="0"><hp:sz width="${Wt}" widthRelTo="ABSOLUTE" height="${Ht}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="141" right="141" top="57" bottom="57"/>${trs}</hp:tbl>`;
    };

    const paras = [];
    layouts.forEach((L, pi) => {
      let cursor = mg.t; // 다음 블록이 놓일 y(pt)
      const cl = mg.l, cr = L.W - mg.r, cc = (cl + cr) / 2;
      L.blocks.forEach((b, bi) => {
        const prev = Math.max(0, b.top - cursor) * PT2HU;
        const pageBreak = pi > 0 && bi === 0 ? 1 : 0;
        if (b.kind === 't') {
          const off = Math.max(0, b.x1 - cl);
          const twidth = b.colW.reduce((a, v) => a + v, 0);
          const centered = Math.abs((b.x1 + b.x1 + twidth) / 2 - cc) < 4 && off > 6;
          const pp = hb.paraPr({ align: centered ? 'CENTER' : 'LEFT', left: centered ? 0 : off * PT2HU, prev, ls: 100 });
          const cp = hb.charPr({ size: 1 });
          paras.push({ pp, pageBreak, inner: `<hp:run charPrIDRef="${cp}">${tableXml(b)}<hp:t/></hp:run>` });
          cursor = b.top + b.rowH.reduce((a, v) => a + v, 0);
        } else {
          let align = b.alignHint && b.alignHint !== 'LEFT' ? b.alignHint : 'LEFT';
          let left = 0;
          const lg = b.x1 - cl, rg = cr - b.x2;
          if (!b.alignHint) {
            if (Math.abs((b.x1 + b.x2) / 2 - cc) < 6 && lg > 24) align = 'CENTER';
            else if (rg < 8 && lg > 60) align = 'RIGHT';
          }
          if (align === 'LEFT' || align === 'JUSTIFY') left = Math.max(0, lg);
          const pp = hb.paraPr({ align, left: left * PT2HU, prev, ls: b.ls || 160, oneLine: !!b.oneLine });
          paras.push({ pp, pageBreak, inner: runXml(b.runs.length ? b.runs : [{ t: '', size: b.size }]) });
          cursor = b.top + b.size * (b.ls || 160) / 100;
        }
      });
      if (!L.blocks.length) {
        const pp = hb.paraPr({});
        paras.push({ pp, pageBreak: pi > 0 ? 1 : 0, inner: `<hp:run charPrIDRef="0"/>` });
      }
    });
    if (!paras.length) paras.push({ pp: 0, pageBreak: 0, inner: '<hp:run charPrIDRef="0"/>' });
    void contentW;

    const body = paras.map((p, i) => {
      const inner = i === 0 ? `<hp:run charPrIDRef="0">${secPr}</hp:run>${p.inner}` : p.inner;
      return `<hp:p id="0" paraPrIDRef="${p.pp}" styleIDRef="0" pageBreak="${p.pageBreak}" columnBreak="0" merged="0">${inner}</hp:p>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>${rootOpen}${body}</hs:sec>`;
  }

  function layoutText(layouts) {
    const out = [];
    for (const L of layouts) for (const b of L.blocks) {
      if (b.kind === 'p') out.push(b.runs.map((r) => r.t).join(''));
      else for (const c of b.cells) for (const p of c.paras || []) { const s = p.runs.map((r) => r.t).join('').trim(); if (s) out.push(s); }
    }
    return out.join('\r\n');
  }

  async function buildHwpx(skeletonBytes, layouts, JSZip, opts = {}) {
    const sk = await JSZip.loadAsync(skeletonBytes);
    const headXml = await sk.file('Contents/header.xml').async('string');
    const secXml = await sk.file('Contents/section0.xml').async('string');
    const hb = new HeaderBuilder(headXml);
    const section = buildSection(secXml, layouts, hb);
    const header = hb.toXml();
    const out = new JSZip();
    out.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    for (const name of Object.keys(sk.files)) {
      const f = sk.files[name];
      if (f.dir || name === 'mimetype') continue;
      if (name === 'Contents/section0.xml') out.file(name, section);
      else if (name === 'Contents/header.xml') out.file(name, header);
      else if (name === 'Preview/PrvText.txt') out.file(name, layoutText(layouts).slice(0, 1024) || ' ');
      else if (name === 'Preview/PrvImage.png' && opts.previewPng) out.file(name, opts.previewPng);
      else if (name === 'Contents/content.hpf') {
        let x = await f.async('string');
        x = x.replace('<opf:title/>', `<opf:title>${esc(opts.title || '')}</opf:title>`)
          .replace(/synthetic-fixture-author/g, esc(opts.author || '양식 되살리기'))
          .replace(/(name="CreatedDate" content="text">)[^<]*/, `$1${now}`)
          .replace(/(name="ModifiedDate" content="text">)[^<]*/, `$1${now}`)
          .replace(/(name="date" content="text">)[^<]*/, '$1');
        out.file(name, x);
      } else out.file(name, await f.async('uint8array'));
    }
    const bytes = await out.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/hwp+zip' });
    return { bytes, stats: statsOf(layouts) };
  }

  function statsOf(layouts) {
    let tables = 0, cells = 0, paras = 0;
    for (const L of layouts) for (const b of L.blocks) { if (b.kind === 't') { tables++; cells += b.cells.length; } else paras++; }
    return { pages: layouts.length, tables, cells, paras };
  }

  /* ============================================================
   * 4. hwpx 검사·잠금 해제
   * ============================================================ */
  async function inspectHwpx(bytes, JSZip) {
    let zip;
    try { zip = await JSZip.loadAsync(bytes); } catch (e) { return { ok: false, reason: 'notzip' }; }
    const names = Object.keys(zip.files);
    const manifest = zip.file('META-INF/manifest.xml') ? await zip.file('META-INF/manifest.xml').async('string') : '';
    const secs = names.filter((n) => /^Contents\/section\d+\.xml$/.test(n)).sort();
    const prv = zip.file('Preview/PrvImage.png') ? await zip.file('Preview/PrvImage.png').async('uint8array') : null;
    let readable = secs.length > 0;
    for (const s of secs) {
      const head = (await zip.file(s).async('uint8array')).slice(0, 64);
      const txt = String.fromCharCode(...head);
      if (!/^\s*(﻿)?<\?xml|^\s*</.test(txt)) readable = false;
    }
    const encrypted = /encryption/i.test(manifest) || !readable;
    let locks = 0;
    if (!encrypted) {
      for (const s of secs) {
        const x = await zip.file(s).async('string');
        locks += (x.match(/\b(protect|lock)="1"/g) || []).length;
      }
      const h = zip.file('Contents/header.xml') ? await zip.file('Contents/header.xml').async('string') : '';
      if (/lockForm="1"/.test(h)) locks++;
    }
    return { ok: true, zip, encrypted, locks, sections: secs, preview: prv };
  }

  async function unlockHwpx(zip, JSZip) {
    const out = new JSZip();
    out.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });
    let changed = 0;
    for (const name of Object.keys(zip.files)) {
      const f = zip.files[name];
      if (f.dir || name === 'mimetype') continue;
      if (/^Contents\/(section\d+|header)\.xml$/.test(name)) {
        let x = await f.async('string');
        x = x.replace(/\b(protect|lock|lockForm)="1"/g, (m, k) => { changed++; return `${k}="0"`; });
        out.file(name, x);
      } else out.file(name, await f.async('uint8array'));
    }
    const bytes = await out.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/hwp+zip' });
    return { bytes, changed };
  }

  const PALETTE = [[255, 0, 0], [0, 0, 255], [0, 128, 0], [128, 0, 128], [0, 0, 128], [128, 0, 0], [0, 128, 128], [192, 0, 0], [0, 112, 192], [255, 0, 255], [0, 176, 80]];
  /** 렌더링한 페이지 픽셀(RGBA)에서 글자색을 읽는 함수 만들기. scale = 픽셀/pt */
  function makeColorSampler(data, width, height, scale) {
    return function (x1, y1, x2, y2) {
      const X1 = clamp(Math.floor(x1 * scale), 0, width - 1), X2 = clamp(Math.ceil(x2 * scale), 0, width - 1);
      const Y1 = clamp(Math.floor(y1 * scale), 0, height - 1), Y2 = clamp(Math.ceil(y2 * scale), 0, height - 1);
      const step = Math.max(1, Math.floor(Math.max(X2 - X1, Y2 - Y1) / 80));
      const px = [];
      for (let y = Y1; y <= Y2; y += step) for (let x = X1; x <= X2; x += step) {
        const i = (y * width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        px.push([r, g, b, 0.299 * r + 0.587 * g + 0.114 * b]);
      }
      if (px.length < 4) return '#000000';
      px.sort((a, b) => a[3] - b[3]);
      const bg = px[px.length - 1];
      const ink = px.slice(0, Math.max(2, Math.floor(px.length * 0.12))).filter((p) => bg[3] - p[3] > 60);
      if (ink.length < 2) return '#000000';
      const avg = [0, 1, 2].map((k) => ink.reduce((s, p) => s + p[k], 0) / ink.length);
      const sat = Math.max(...avg) - Math.min(...avg);
      if (sat < 45) return '#000000';
      const hx = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
      // 한글 기본 색상표로 맞춤(안티에일리어싱 번짐 보정)
      let best = null, bd = 1e9;
      for (const c of PALETTE) { const d = Math.hypot(c[0] - avg[0], c[1] - avg[1], c[2] - avg[2]); if (d < bd) { bd = d; best = c; } }
      const out = best && bd < 110 ? best : avg;
      return ('#' + hx(out[0]) + hx(out[1]) + hx(out[2])).toUpperCase();
    };
  }

  const api = { hwpWidth, fitSpacing, makeColorSampler, extractPdfPage, aiToLayout, buildHwpx, inspectHwpx, unlockHwpx, statsOf, AI_PROMPT, MM2PT, normalizeFont, buildLayoutFromPrimitives };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FormEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
