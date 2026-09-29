/*
 * Halftone QR engine.
 *
 * Every QR module is drawn as a 3 x 3 block of sub-pixels. Only the centre
 * sub-pixel has to match the module's bit, so the eight around it are free to
 * carry a dithered rendering of a picture. Only the finder and alignment
 * patterns are drawn solid, because scanners use them to locate the code;
 * every other module (data, timing, format, version) is a centre dot.
 *
 * Two styles:
 *   "inside" - the picture keeps its shape. The code is placed in a square
 *              inside the picture's silhouette, in the spot whose tone and
 *              texture hide it best, and only the silhouette is drawn.
 *   "like"   - the whole code is the picture: the picture is placed inside the
 *              code and every dot belongs to the code.
 *
 * The module is environment-neutral: it takes a `sample(width, height)`
 * callback that returns the picture resized to the requested size as an
 * ImageData-like object ({ width, height, data: RGBA bytes }).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HalftoneQR = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ALIGNMENT = [
    [],
    [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54],
    [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74],
    [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
    [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102],
    [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114],
    [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126],
    [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138],
    [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146],
    [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154],
    [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162],
    [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170]
  ];

  const SUB = 3;                   // sub-pixels per module side
  const LEVEL = "H";               // error correction: 30% recoverable
  const LIKE_VERSION = 25;         // 117 modules -> 351 picture pixels across
  const ANALYSIS_SHORT_SIDE = 150; // resolution used to find the silhouette

  // Tunable rendering constants (exposed as HalftoneQR.config).
  const config = {
    targetShortSide: 320,    // picture resolution aimed for in "inside" mode (sub-pixels)
    maxShortSide: 900,       // never dither finer than this
    hiding: { easy: 1, balanced: 1.7, hidden: 2.5 }, // module-count multipliers per hiding level
    placement: {             // scoring of candidate code positions in "inside" mode
      centre: 1.2,           //   penalty per (distance to the shape's centre / short side)
      blank: 2,              //   penalty per fraction of blank (near-white) pixels under the code
      tone: 0.5,             //   penalty per luminance distance from `idealTone`
      texture: 0.3,          //   reward per unit of local texture (standard deviation)
      idealTone: 0.45,       //   luminance the code blends into best (0 black .. 1 white)
      blankTone: 0.9,        //   luminance above which a pixel counts as blank
      cornerPatch: 0.22,     //   corner patch size (share of the code side) that must not be blank
      cornerBlankMax: 0.25,  //   corners with more blank than this are avoided
      cornerPenalty: 3       //   penalty when a corner is blank
    },
    quietLike: 4,            // quiet-zone modules around the code in "like" mode
    quietInside: 1,          // light-ring modules around the code in "inside" mode
    ringFinderOnly: true,    // "inside": lighten only beside the finder squares, not the whole edge
    solidAllAlignment: false, // "inside": draw every alignment pattern solid (false: bottom-right only)
    neighbourBias: 0.2,      // pull the 4 sub-pixels around a centre dot toward its bit (0..1)
    gamma: 1.6,              // tone curve applied before dithering
    centreError: 0.55,       // how much of a forced centre dot's error is diffused
    ringInner: 1,            // lightening right next to the code (1 = pure white)
    ringOuterLike: 0.86,     // lightening at the picture edge in "like" mode
    ringOuterInside: 0.8,    // lightening at the outer edge of the ring in "inside" mode
    featherModules: 1,       // how far the ring fades into the picture (modules)
    backgroundTolerance: 48, // RGB distance from the edge colour still counted as background
    minSilhouette: 0.08,     // silhouettes covering less than this are ignored
    maxSilhouette: 0.97,     // silhouettes covering more than this are ignored
    minSquare: 0.22          // below this share of the short side the code spans the shape instead
  };

  const SHARE = { small: 0.68, medium: 0.92 };     // share of the largest inscribed square used by the code
  const LIKE_PICTURE = { small: 0.7, medium: 1 };  // share of the code covered by the picture
  const INK = { dark: 0.2, light: 0.12 };          // how much picture colour the dots keep

  /* ---------- QR helpers ---------- */

  function versionFor(qrcode, text) {
    const probe = qrcode(0, LEVEL);
    probe.addData(text);
    probe.make();
    return (probe.getModuleCount() - 17) / 4;
  }

  function makeCode(qrcode, text, version) {
    const code = qrcode(version, LEVEL);
    code.addData(text);
    code.make();
    return code;
  }

  /*
   * Modules that must be drawn solid: finder patterns with their separators,
   * and alignment patterns. Decoders only use the bottom-right alignment
   * pattern, so `allAlignment` false keeps just that one solid.
   */
  function solidMap(version, allAlignment) {
    const M = version * 4 + 17;
    const map = new Uint8Array(M * M);
    const mark = (r, c) => {
      if (r >= 0 && c >= 0 && r < M && c < M) map[r * M + c] = 1;
    };
    for (let r = 0; r < 8; r += 1) {
      for (let c = 0; c < 8; c += 1) {
        mark(r, c);
        mark(r, M - 1 - c);
        mark(M - 1 - r, c);
      }
    }
    const positions = ALIGNMENT[version - 1] || [];
    const last = positions[positions.length - 1];
    for (let i = 0; i < positions.length; i += 1) {
      for (let j = 0; j < positions.length; j += 1) {
        const pr = positions[i];
        const pc = positions[j];
        if ((pr === 6 && pc === 6) || (pr === 6 && pc === last) || (pr === last && pc === 6)) continue;
        if (!allAlignment && !(pr === last && pc === last)) continue;
        for (let dr = -2; dr <= 2; dr += 1) {
          for (let dc = -2; dc <= 2; dc += 1) mark(pr + dr, pc + dc);
        }
      }
    }
    return map;
  }

  /* ---------- silhouette analysis ---------- */

  function floodFrom(seedTest, passable, width, height) {
    const visited = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = y * width + x;
        if (seedTest(x, y) && passable(idx)) {
          visited[idx] = 1;
          queue[tail++] = idx;
        }
      }
    }
    while (head < tail) {
      const idx = queue[head++];
      const x = idx % width;
      const y = (idx - x) / width;
      if (x > 0 && !visited[idx - 1] && passable(idx - 1)) { visited[idx - 1] = 1; queue[tail++] = idx - 1; }
      if (x < width - 1 && !visited[idx + 1] && passable(idx + 1)) { visited[idx + 1] = 1; queue[tail++] = idx + 1; }
      if (y > 0 && !visited[idx - width] && passable(idx - width)) { visited[idx - width] = 1; queue[tail++] = idx - width; }
      if (y < height - 1 && !visited[idx + width] && passable(idx + width)) { visited[idx + width] = 1; queue[tail++] = idx + width; }
    }
    return visited;
  }

  function isBorder(x, y, width, height, band) {
    return x < band || y < band || x >= width - band || y >= height - band;
  }

  function removeSpecks(mask, width, height, minArea) {
    const seen = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    for (let start = 0; start < mask.length; start += 1) {
      if (!mask[start] || seen[start]) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      seen[start] = 1;
      while (head < tail) {
        const idx = queue[head++];
        const x = idx % width;
        const y = (idx - x) / width;
        const next = [idx - 1, idx + 1, idx - width, idx + width];
        const ok = [x > 0, x < width - 1, y > 0, y < height - 1];
        for (let k = 0; k < 4; k += 1) {
          const n = next[k];
          if (ok[k] && mask[n] && !seen[n]) {
            seen[n] = 1;
            queue[tail++] = n;
          }
        }
      }
      if (tail < minArea) {
        for (let i = 0; i < tail; i += 1) mask[queue[i]] = 0;
      }
    }
  }

  /* Largest inscribed square of a binary mask, plus the per-pixel "largest square ending here" table. */
  function largestSquare(mask, width, height) {
    const side = new Int32Array(width * height);
    let sumX = 0;
    let sumY = 0;
    let area = 0;
    for (let i = 0; i < mask.length; i += 1) {
      if (mask[i]) {
        area += 1;
        sumX += i % width;
        sumY += Math.floor(i / width);
      }
    }
    const cx = area ? sumX / area : width / 2;
    const cy = area ? sumY / area : height / 2;
    let best = 0;
    let bestX = 0;
    let bestY = 0;
    let bestDist = Infinity;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = y * width + x;
        if (!mask[idx]) continue;
        let s = 1;
        if (x > 0 && y > 0) {
          s = Math.min(side[idx - 1], side[idx - width], side[idx - width - 1]) + 1;
        }
        side[idx] = s;
        const dist = Math.hypot(x - s / 2 - cx, y - s / 2 - cy);
        if (s > best || (s === best && dist < bestDist)) {
          best = s;
          bestX = x - s + 1;
          bestY = y - s + 1;
          bestDist = dist;
        }
      }
    }
    return { square: { x: bestX, y: bestY, side: best }, side };
  }

  function boundingBox(mask, width, height) {
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!mask[y * width + x]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  }

  function blurMask(mask, width, height) {
    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
            sum += mask[yy * width + xx];
            n += 1;
          }
        }
        out[y * width + x] = sum / n;
      }
    }
    return out;
  }

  function luminancePlane(image) {
    const { width, height, data } = image;
    const gray = new Float32Array(width * height);
    for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
      const a = data[p + 3] / 255;
      const r = data[p] * a + 255 * (1 - a);
      const g = data[p + 1] * a + 255 * (1 - a);
      const b = data[p + 2] * a + 255 * (1 - a);
      gray[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }
    return gray;
  }

  /*
   * Finds the picture's silhouette at a small analysis resolution.
   * mode: "auto" (alpha channel, else plain background at the edges) | "whole"
   */
  function analyse(sample, aspect, mode) {
    let width;
    let height;
    if (aspect >= 1) {
      height = ANALYSIS_SHORT_SIDE;
      width = Math.max(1, Math.round(height * aspect));
    } else {
      width = ANALYSIS_SHORT_SIDE;
      height = Math.max(1, Math.round(width / aspect));
    }
    const shortSide = Math.min(width, height);
    const image = sample(width, height);
    const data = image.data;
    const count = width * height;
    const tone = luminancePlane(image);

    const whole = () => {
      const mask = new Uint8Array(count).fill(1);
      const found = largestSquare(mask, width, height);
      return {
        width, height, mask, soft: null, tone, side: found.side, coverage: 1, detected: "none",
        square: found.square, bbox: { x: 0, y: 0, width, height }
      };
    };
    if (mode === "whole") return whole();

    let mask;
    let detected;
    let transparent = 0;
    for (let i = 0; i < count; i += 1) if (data[i * 4 + 3] < 128) transparent += 1;

    if (transparent > count * 0.02) {
      mask = new Uint8Array(count);
      for (let i = 0; i < count; i += 1) mask[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
      detected = "alpha";
    } else {
      const band = Math.max(2, Math.round(shortSide * 0.03));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (!isBorder(x, y, width, height, band)) continue;
          const p = (y * width + x) * 4;
          r += data[p];
          g += data[p + 1];
          b += data[p + 2];
          n += 1;
        }
      }
      r /= n;
      g /= n;
      b /= n;
      const distance = new Float32Array(count);
      let spread = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const idx = y * width + x;
          const p = idx * 4;
          distance[idx] = Math.hypot(data[p] - r, data[p + 1] - g, data[p + 2] - b);
          if (isBorder(x, y, width, height, band)) spread += distance[idx];
        }
      }
      spread /= n;
      if (spread > config.backgroundTolerance * 0.6) return whole();
      const tolerance = config.backgroundTolerance;
      const background = floodFrom(
        (x, y) => isBorder(x, y, width, height, band),
        (idx) => distance[idx] < tolerance,
        width, height
      );
      mask = new Uint8Array(count);
      for (let i = 0; i < count; i += 1) mask[i] = background[i] ? 0 : 1;
      detected = "edges";
    }

    removeSpecks(mask, width, height, Math.round(count * 0.015));
    const outside = floodFrom(
      (x, y) => isBorder(x, y, width, height, 1),
      (idx) => !mask[idx],
      width, height
    );
    let area = 0;
    for (let i = 0; i < count; i += 1) {
      mask[i] = outside[i] ? 0 : 1;
      area += mask[i];
    }
    const coverage = area / count;
    if (coverage < config.minSilhouette || coverage > config.maxSilhouette) return whole();

    const found = largestSquare(mask, width, height);
    return {
      width, height, mask, soft: blurMask(mask, width, height), tone, side: found.side, coverage, detected,
      square: found.square,
      bbox: boundingBox(mask, width, height)
    };
  }

  /*
   * Among all squares of side `s` that fit inside the silhouette, picks the one
   * that is closest to the centre of the shape, sits on picture content rather
   * than blank areas (especially at its corners, where the finder squares go),
   * and whose tone and texture hide the code best.
   */
  function bestSquare(analysis, s) {
    const { width, height, side, tone, mask } = analysis;
    const P = config.placement;
    if (s < 1) return null;
    const W1 = width + 1;
    const sum = new Float64Array(W1 * (height + 1));
    const sumSq = new Float64Array(W1 * (height + 1));
    const blank = new Float64Array(W1 * (height + 1));
    let cx = 0;
    let cy = 0;
    let area = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = y * width + x;
        const t = tone[idx];
        const here = (y + 1) * W1 + x + 1;
        sum[here] = t + sum[here - 1] + sum[here - W1] - sum[here - W1 - 1];
        sumSq[here] = t * t + sumSq[here - 1] + sumSq[here - W1] - sumSq[here - W1 - 1];
        const isBlank = (!mask[idx] || t > P.blankTone) ? 1 : 0;
        blank[here] = isBlank + blank[here - 1] + blank[here - W1] - blank[here - W1 - 1];
        if (mask[idx] && t <= P.blankTone) {
          cx += x;
          cy += y;
          area += 1;
        }
      }
    }
    cx = area ? cx / area : width / 2;
    cy = area ? cy / area : height / 2;
    const shortSide = Math.min(width, height);
    const boxSum = (table, x0, y0, w, h) =>
      table[(y0 + h) * W1 + x0 + w] - table[y0 * W1 + x0 + w] - table[(y0 + h) * W1 + x0] + table[y0 * W1 + x0];

    const squareArea = s * s;
    const patch = Math.max(2, Math.round(s * P.cornerPatch));
    const patchArea = patch * patch;
    let best = null;
    let bestScore = -Infinity;
    for (let y = s - 1; y < height; y += 1) {
      for (let x = s - 1; x < width; x += 1) {
        if (side[y * width + x] < s) continue;
        const x0 = x - s + 1;
        const y0 = y - s + 1;
        const mean = boxSum(sum, x0, y0, s, s) / squareArea;
        const variance = boxSum(sumSq, x0, y0, s, s) / squareArea - mean * mean;
        const texture = Math.sqrt(Math.max(0, variance));
        const blankShare = boxSum(blank, x0, y0, s, s) / squareArea;
        const cornerBlank = Math.max(
          boxSum(blank, x0, y0, patch, patch),
          boxSum(blank, x0 + s - patch, y0, patch, patch),
          boxSum(blank, x0, y0 + s - patch, patch, patch),
          boxSum(blank, x0 + s - patch, y0 + s - patch, patch, patch)
        ) / patchArea;
        const distance = Math.hypot(x0 + s / 2 - cx, y0 + s / 2 - cy) / shortSide;
        let score = -P.centre * distance
          - P.blank * blankShare
          - P.tone * Math.abs(mean - P.idealTone)
          + P.texture * texture;
        if (cornerBlank > P.cornerBlankMax) score -= P.cornerPenalty;
        if (score > bestScore) {
          bestScore = score;
          best = { x: x0, y: y0, side: s };
        }
      }
    }
    return best;
  }

  /* ---------- layout ---------- */

  function containRect(boxW, boxH, aspect) {
    let width;
    let height;
    if (aspect >= boxW / boxH) {
      width = boxW;
      height = Math.max(1, Math.round(boxW / aspect));
    } else {
      height = boxH;
      width = Math.max(1, Math.round(boxH * aspect));
    }
    return { x: Math.round((boxW - width) / 2), y: Math.round((boxH - height) / 2), width, height };
  }

  function coverRect(boxW, boxH, aspect) {
    let width;
    let height;
    if (aspect >= boxW / boxH) {
      height = boxH;
      width = Math.max(1, Math.round(boxH * aspect));
    } else {
      width = boxW;
      height = Math.max(1, Math.round(boxW / aspect));
    }
    return { x: Math.round((boxW - width) / 2), y: Math.round((boxH - height) / 2), width, height };
  }

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function plan(options) {
    const { style, size, hiding, aspect, minVersion, analysis } = options;
    if (style === "like") {
      const quiet = config.quietLike;
      const version = Math.max(minVersion, LIKE_VERSION);
      const modules = version * 4 + 17;
      const side = (modules + quiet * 2) * SUB;
      const origin = quiet * SUB;
      let picture;
      if (size === "medium") {
        picture = coverRect(side, side, aspect);
      } else {
        const box = Math.round(modules * SUB * LIKE_PICTURE.small);
        picture = containRect(box, box, aspect);
        picture.x += Math.round((side - box) / 2);
        picture.y += Math.round((side - box) / 2);
      }
      return {
        style, size, version, modules, quiet,
        width: side, height: side, qx: origin, qy: origin,
        picture, ringOuter: config.ringOuterLike, feather: 0, spill: false
      };
    }

    const quiet = config.quietInside;
    const shortA = Math.min(analysis.width, analysis.height);
    const factor = config.hiding[hiding] || config.hiding.balanced;
    let square;
    let spill = false;
    if (analysis.detected !== "none" && analysis.square.side / shortA < config.minSquare) {
      const bbox = analysis.bbox;
      const side = Math.max(bbox.width, bbox.height);
      square = { x: bbox.x + (bbox.width - side) / 2, y: bbox.y + (bbox.height - side) / 2, side };
      spill = true;
    } else {
      const s = Math.max(1, Math.round(analysis.square.side * SHARE[size]));
      square = bestSquare(analysis, s) || analysis.square;
    }
    const span = square.side / shortA;
    const wantedModules = ((config.targetShortSide * span) / SUB) * factor;
    const version = clamp(Math.round((wantedModules - 17) / 4), Math.max(1, minVersion), 40);
    const modules = version * 4 + 17;
    let short = Math.ceil((modules * SUB) / span);
    if (short > config.maxShortSide) {
      short = config.maxShortSide;
      spill = true;
    }
    let width;
    let height;
    if (aspect >= 1) {
      height = short;
      width = Math.round(short * aspect);
    } else {
      width = short;
      height = Math.round(short / aspect);
    }
    const scale = short / shortA;
    const codePx = modules * SUB;
    const cx = (square.x + square.side / 2) * scale;
    const cy = (square.y + square.side / 2) * scale;
    const qx = clamp(Math.round(cx - codePx / 2), 0, Math.max(0, width - codePx));
    const qy = clamp(Math.round(cy - codePx / 2), 0, Math.max(0, height - codePx));
    return {
      style, size, version, modules, quiet,
      width, height, qx, qy,
      picture: { x: 0, y: 0, width, height },
      ringOuter: config.ringOuterInside, feather: config.featherModules * SUB, spill
    };
  }

  /* ---------- tone ---------- */

  function autoLevels(gray, weight) {
    const bins = new Uint32Array(256);
    let total = 0;
    for (let i = 0; i < gray.length; i += 1) {
      if (weight && weight[i] < 0.5) continue;
      bins[Math.round(gray[i] * 255)] += 1;
      total += 1;
    }
    if (!total) return;
    let lo = 0;
    let hi = 255;
    let seen = 0;
    for (let i = 0; i < 256; i += 1) {
      seen += bins[i];
      if (seen >= total * 0.01) { lo = i; break; }
    }
    seen = 0;
    for (let i = 255; i >= 0; i -= 1) {
      seen += bins[i];
      if (seen >= total * 0.01) { hi = i; break; }
    }
    const range = (hi - lo) / 255;
    if (range < 0.3 || range > 0.98) return;
    const low = lo / 255;
    for (let i = 0; i < gray.length; i += 1) {
      gray[i] = Math.min(1, Math.max(0, (gray[i] - low) / range));
    }
  }

  function ringFactor(distance, layout) {
    const ring = layout.quiet * SUB;
    if (distance <= 0) return 0;
    if (distance <= ring) {
      if (ring <= 1) return config.ringInner;
      return config.ringInner + (layout.ringOuter - config.ringInner) * ((distance - 1) / (ring - 1));
    }
    if (layout.feather > 0 && distance <= ring + layout.feather) {
      return layout.ringOuter * (1 - (distance - ring) / layout.feather);
    }
    return 0;
  }

  function distanceToCode(x, y, layout) {
    const codePx = layout.modules * SUB;
    const dx = Math.max(layout.qx - x, x - (layout.qx + codePx - 1), 0);
    const dy = Math.max(layout.qy - y, y - (layout.qy + codePx - 1), 0);
    return Math.max(dx, dy);
  }

  /* True when (x, y) lies beside one of the three finder patterns (8 modules plus one extra). */
  function nearFinder(x, y, layout) {
    const zone = 9 * SUB;
    const codePx = layout.modules * SUB;
    const left = x < layout.qx + zone;
    const right = x >= layout.qx + codePx - zone;
    const top = y < layout.qy + zone;
    const bottom = y >= layout.qy + codePx - zone;
    return (left && top) || (right && top) || (left && bottom);
  }

  function sampleMask(analysis, u, v) {
    // bilinear lookup of the soft silhouette mask; u, v in analysis pixel units
    const { width, height, soft } = analysis;
    const x = clamp(u - 0.5, 0, width - 1);
    const y = clamp(v - 0.5, 0, height - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const fx = x - x0;
    const fy = y - y0;
    const top = soft[y0 * width + x0] * (1 - fx) + soft[y0 * width + x1] * fx;
    const bottom = soft[y1 * width + x0] * (1 - fx) + soft[y1 * width + x1] * fx;
    return top * (1 - fy) + bottom * fy;
  }

  /* ---------- dithering ---------- */

  function dither(target, constraints, width, height) {
    const work = Float32Array.from(target);
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      const ltr = (y & 1) === 0;
      const dx = ltr ? 1 : -1;
      for (let i = 0; i < width; i += 1) {
        const x = ltr ? i : width - 1 - i;
        const idx = y * width + x;
        const value = Math.min(1.3, Math.max(-0.3, work[idx]));
        const rule = constraints[idx];
        let output;
        let error;
        if (rule === 0 || rule === 1) {
          output = rule;
          error = (value - output) * config.centreError;
        } else if (rule === 2 || rule === 3) {
          output = rule - 2;
          error = 0;
        } else {
          output = value >= 0.5 ? 1 : 0;
          error = value - output;
        }
        out[idx] = output;
        if (error === 0) continue;
        const hasNext = x + dx >= 0 && x + dx < width;
        const hasPrev = x - dx >= 0 && x - dx < width;
        if (hasNext) work[idx + dx] += error * (7 / 16);
        if (y + 1 < height) {
          const below = idx + width;
          if (hasPrev) work[below - dx] += error * (3 / 16);
          work[below] += error * (5 / 16);
          if (hasNext) work[below + dx] += error * (1 / 16);
        }
      }
    }
    return out;
  }

  /*
   * options:
   *   qrcode     - the qrcode-generator factory
   *   text       - data to encode
   *   style      - "inside" (code hidden in the picture) | "like" (code is the picture)
   *   size       - "small" | "medium"
   *   hiding     - "easy" | "balanced" | "hidden" (inside only)
   *   silhouette - "auto" | "whole"
   *   ink        - "mono" | "color"
   *   aspect     - picture width / height
   *   sample     - function(width, height) -> { width, height, data(RGBA) }
   */
  function render(options) {
    const style = options.style === "like" ? "like" : "inside";
    const size = options.size === "medium" ? "medium" : "small";
    const hiding = config.hiding[options.hiding] ? options.hiding : "balanced";
    const aspect = options.aspect > 0 ? options.aspect : 1;
    const minVersion = versionFor(options.qrcode, options.text);
    const analysis = analyse(options.sample, aspect, options.silhouette === "whole" ? "whole" : "auto");
    const layout = plan({ style, size, hiding, aspect, minVersion, analysis });
    const code = makeCode(options.qrcode, options.text, layout.version);
    const solid = solidMap(layout.version, style === "like" || config.solidAllAlignment);
    const { width, height, modules, qx, qy } = layout;
    const count = width * height;

    const picture = options.sample(layout.picture.width, layout.picture.height);
    const pw = picture.width;
    const ph = picture.height;
    const px = layout.picture.x;
    const py = layout.picture.y;

    // silhouette weight per picture pixel (1 inside the shape, 0 outside)
    let weight = null;
    if (analysis.soft) {
      weight = new Float32Array(pw * ph);
      const su = analysis.width / pw;
      const sv = analysis.height / ph;
      for (let y = 0; y < ph; y += 1) {
        for (let x = 0; x < pw; x += 1) {
          weight[y * pw + x] = sampleMask(analysis, (x + 0.5) * su, (y + 0.5) * sv);
        }
      }
    }

    const gray = luminancePlane(picture);
    autoLevels(gray, weight);

    const target = new Float32Array(count).fill(1);
    const color = options.ink === "color" ? new Float32Array(count * 3).fill(1) : null;
    for (let y = 0; y < ph; y += 1) {
      const ty = y + py;
      if (ty < 0 || ty >= height) continue;
      for (let x = 0; x < pw; x += 1) {
        const tx = x + px;
        if (tx < 0 || tx >= width) continue;
        const src = y * pw + x;
        const dst = ty * width + tx;
        const w = weight ? weight[src] : 1;
        const tone = Math.pow(gray[src], config.gamma);
        target[dst] = 1 - (1 - tone) * w;
        if (color) {
          const p = src * 4;
          const a = (picture.data[p + 3] / 255) * w;
          color[dst * 3] = (picture.data[p] * a + 255 * (1 - a)) / 255;
          color[dst * 3 + 1] = (picture.data[p + 1] * a + 255 * (1 - a)) / 255;
          color[dst * 3 + 2] = (picture.data[p + 2] * a + 255 * (1 - a)) / 255;
        }
      }
    }

    const ringReach = Math.ceil(layout.quiet * SUB + layout.feather);
    const x0 = Math.max(0, qx - ringReach);
    const x1 = Math.min(width, qx + modules * SUB + ringReach);
    const y0 = Math.max(0, qy - ringReach);
    const y1 = Math.min(height, qy + modules * SUB + ringReach);
    const finderOnly = style === "inside" && config.ringFinderOnly;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const k = ringFactor(distanceToCode(x, y, layout), layout);
        if (k <= 0) continue;
        if (finderOnly && !nearFinder(x, y, layout)) continue;
        const idx = y * width + x;
        target[idx] = 1 - (1 - target[idx]) * (1 - k);
      }
    }

    // constraints: 255 free, 0/1 forced centre dot (error diffused), 2/3 solid module
    const constraints = new Uint8Array(count).fill(255);
    for (let r = 0; r < modules; r += 1) {
      for (let c = 0; c < modules; c += 1) {
        const dark = code.isDark(r, c);
        const bx = qx + c * SUB;
        const by = qy + r * SUB;
        if (solid[r * modules + c]) {
          const rule = dark ? 2 : 3;
          for (let dy = 0; dy < SUB; dy += 1) {
            for (let dx = 0; dx < SUB; dx += 1) constraints[(by + dy) * width + bx + dx] = rule;
          }
        } else {
          constraints[(by + 1) * width + bx + 1] = dark ? 0 : 1;
          if (config.neighbourBias > 0) {
            const bit = dark ? 0 : 1;
            const b = config.neighbourBias;
            for (const [dx, dy] of [[0, 1], [2, 1], [1, 0], [1, 2]]) {
              const idx = (by + dy) * width + bx + dx;
              target[idx] = target[idx] * (1 - b) + bit * b;
            }
          }
        }
      }
    }

    const bits = dither(target, constraints, width, height);
    return {
      width, height, bits, color, layout, modules,
      version: layout.version,
      hiding,
      silhouette: analysis.detected,
      coverage: analysis.coverage,
      spill: layout.spill,
      scale: SUB
    };
  }

  function toRGBA(result, out) {
    const { width, height, bits, color } = result;
    const rgba = out || new Uint8ClampedArray(width * height * 4);
    for (let i = 0, p = 0; i < bits.length; i += 1, p += 4) {
      const light = bits[i] === 1;
      if (color) {
        const r = color[i * 3];
        const g = color[i * 3 + 1];
        const b = color[i * 3 + 2];
        if (light) {
          rgba[p] = 255 - (1 - r) * INK.light * 255;
          rgba[p + 1] = 255 - (1 - g) * INK.light * 255;
          rgba[p + 2] = 255 - (1 - b) * INK.light * 255;
        } else {
          rgba[p] = r * INK.dark * 255;
          rgba[p + 1] = g * INK.dark * 255;
          rgba[p + 2] = b * INK.dark * 255;
        }
      } else {
        const v = light ? 255 : 0;
        rgba[p] = v;
        rgba[p + 1] = v;
        rgba[p + 2] = v;
      }
      rgba[p + 3] = 255;
    }
    return rgba;
  }

  function suggestedScale(result, maxSide) {
    const longest = Math.max(result.width, result.height);
    return Math.max(2, Math.min(8, Math.floor((maxSide || 3000) / longest)));
  }

  return { render, toRGBA, suggestedScale, analyse, solidMap, plan, config, SUB, LEVEL };
});
