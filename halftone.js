/*
 * Halftone QR engine.
 *
 * Every QR module is drawn as a 3 x 3 block of sub-pixels. Only the centre
 * sub-pixel has to match the module's bit, so the eight around it are free to
 * carry a dithered rendering of a picture. Finder, timing, alignment, format
 * and version patterns are drawn solid so scanners can lock on to the code.
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

  const SUB = 3;                 // sub-pixels per module side
  const QUIET = 4;               // quiet-zone width in modules
  const LEVEL = "H";             // error correction: 30% recoverable
  const LIKE_VERSION = 25;       // 117 modules -> 351 picture pixels across
  // Tunable rendering constants (exposed as HalftoneQR.config).
  const config = {
    insideShortSide: 300,// target picture resolution in "inside" mode (sub-pixels)
    neighbourBias: 0.2,  // pull the 4 sub-pixels around a centre dot toward its bit (0..1)
    gamma: 1.6,          // tone curve applied before dithering
    centreError: 0.55,   // how much of a forced centre dot's error is diffused
    ringInner: 1,        // lightening right next to the code (1 = pure white)
    ringOuterLike: 0.86, // lightening at the picture edge in "like" mode
    ringOuterInside: 0.8, // lightening at the outer edge of the ring in "inside" mode
    featherModules: 2    // how far the ring fades into the picture (modules)
  };

  const STYLES = {
    inside: {
      small: { span: 0.44 },
      medium: { span: 0.64 }
    },
    like: {
      small: { picture: 0.7 },
      medium: { picture: 1 }
    }
  };

  const INK = {
    dark: 0.2,    // dark dots keep 20% of the picture colour
    light: 0.12   // light dots keep 12% of the picture colour
  };

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

  function functionMap(version) {
    const M = version * 4 + 17;
    const map = new Uint8Array(M * M);
    const mark = (r, c) => {
      if (r >= 0 && c >= 0 && r < M && c < M) map[r * M + c] = 1;
    };
    for (let r = 0; r < 9; r += 1) {
      for (let c = 0; c < 9; c += 1) {
        mark(r, c);
        if (c < 8) mark(r, M - 1 - c);
        if (r < 8) mark(M - 1 - r, c);
      }
    }
    for (let i = 8; i < M - 8; i += 1) {
      mark(6, i);
      mark(i, 6);
    }
    const positions = ALIGNMENT[version - 1] || [];
    const last = positions[positions.length - 1];
    for (let i = 0; i < positions.length; i += 1) {
      for (let j = 0; j < positions.length; j += 1) {
        const pr = positions[i];
        const pc = positions[j];
        if ((pr === 6 && pc === 6) || (pr === 6 && pc === last) || (pr === last && pc === 6)) continue;
        for (let dr = -2; dr <= 2; dr += 1) {
          for (let dc = -2; dc <= 2; dc += 1) mark(pr + dr, pc + dc);
        }
      }
    }
    if (version >= 7) {
      for (let a = 0; a < 6; a += 1) {
        for (let b = 0; b < 3; b += 1) {
          mark(a, M - 11 + b);
          mark(M - 11 + b, a);
        }
      }
    }
    return map;
  }

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

  function plan(options) {
    const { style, size, position, aspect, minVersion } = options;
    if (style === "like") {
      const version = Math.max(minVersion, LIKE_VERSION);
      const modules = version * 4 + 17;
      const side = (modules + QUIET * 2) * SUB;
      const origin = QUIET * SUB;
      let picture;
      if (size === "medium") {
        picture = coverRect(side, side, aspect);
      } else {
        const box = Math.round(modules * SUB * STYLES.like.small.picture);
        picture = containRect(box, box, aspect);
        picture.x += Math.round((side - box) / 2);
        picture.y += Math.round((side - box) / 2);
      }
      return {
        style, size, version, modules,
        width: side, height: side, qx: origin, qy: origin,
        picture, ringOuter: config.ringOuterLike, feather: 0
      };
    }

    const span = STYLES.inside[size].span;
    const wantedModules = (config.insideShortSide * span) / SUB - QUIET * 2;
    const wanted = Math.round((wantedModules - 17) / 4);
    const version = Math.min(40, Math.max(minVersion, wanted, 1));
    const modules = version * 4 + 17;
    const spanPx = (modules + QUIET * 2) * SUB;
    const short = Math.ceil(spanPx / span);
    let width;
    let height;
    if (aspect >= 1) {
      height = short;
      width = Math.round(short * aspect);
    } else {
      width = short;
      height = Math.round(short / aspect);
    }
    const codePx = modules * SUB;
    const margin = (QUIET + 1) * SUB;
    let qx = Math.round((width - codePx) / 2);
    let qy = Math.round((height - codePx) / 2);
    if (position === "top-left" || position === "bottom-left") qx = margin;
    if (position === "top-right" || position === "bottom-right") qx = width - margin - codePx;
    if (position === "top-left" || position === "top-right") qy = margin;
    if (position === "bottom-left" || position === "bottom-right") qy = height - margin - codePx;
    return {
      style, size, version, modules,
      width, height, qx, qy,
      picture: { x: 0, y: 0, width, height },
      ringOuter: config.ringOuterInside, feather: config.featherModules * SUB
    };
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

  function autoLevels(gray) {
    const bins = new Uint32Array(256);
    for (let i = 0; i < gray.length; i += 1) bins[Math.round(gray[i] * 255)] += 1;
    const total = gray.length;
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
    const ring = QUIET * SUB;
    if (distance <= 0) return 0;
    if (distance <= ring) {
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
   *   qrcode   - the qrcode-generator factory
   *   text     - data to encode
   *   style    - "inside" (code woven into the picture) | "like" (code is the picture)
   *   size     - "small" | "medium"
   *   position - for "inside": center | top-left | top-right | bottom-left | bottom-right
   *   ink      - "mono" | "color"
   *   aspect   - picture width / height
   *   sample   - function(width, height) -> { width, height, data(RGBA) }
   */
  function render(options) {
    const style = options.style === "like" ? "like" : "inside";
    const size = options.size === "medium" ? "medium" : "small";
    const minVersion = versionFor(options.qrcode, options.text);
    const layout = plan({
      style, size,
      position: options.position || "center",
      aspect: options.aspect > 0 ? options.aspect : 1,
      minVersion
    });
    const code = makeCode(options.qrcode, options.text, layout.version);
    const fmap = functionMap(layout.version);
    const { width, height, modules, qx, qy } = layout;
    const count = width * height;

    const picture = options.sample(layout.picture.width, layout.picture.height);
    const gray = luminancePlane(picture);
    autoLevels(gray);

    const target = new Float32Array(count).fill(1);
    const color = options.ink === "color" ? new Float32Array(count * 3).fill(1) : null;
    const px = layout.picture.x;
    const py = layout.picture.y;
    const pw = picture.width;
    for (let y = 0; y < picture.height; y += 1) {
      const ty = y + py;
      if (ty < 0 || ty >= height) continue;
      for (let x = 0; x < pw; x += 1) {
        const tx = x + px;
        if (tx < 0 || tx >= width) continue;
        const src = y * pw + x;
        const dst = ty * width + tx;
        target[dst] = Math.pow(gray[src], config.gamma);
        if (color) {
          const p = src * 4;
          const a = picture.data[p + 3] / 255;
          color[dst * 3] = (picture.data[p] * a + 255 * (1 - a)) / 255;
          color[dst * 3 + 1] = (picture.data[p + 1] * a + 255 * (1 - a)) / 255;
          color[dst * 3 + 2] = (picture.data[p + 2] * a + 255 * (1 - a)) / 255;
        }
      }
    }

    const ringReach = QUIET * SUB + layout.feather;
    const x0 = Math.max(0, qx - ringReach);
    const x1 = Math.min(width, qx + modules * SUB + ringReach);
    const y0 = Math.max(0, qy - ringReach);
    const y1 = Math.min(height, qy + modules * SUB + ringReach);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const k = ringFactor(distanceToCode(x, y, layout), layout);
        if (k <= 0) continue;
        const idx = y * width + x;
        target[idx] = 1 - (1 - target[idx]) * (1 - k);
      }
    }

    // constraints: 255 free, 0/1 forced centre dot (error diffused), 2/3 solid function module
    const constraints = new Uint8Array(count).fill(255);
    for (let r = 0; r < modules; r += 1) {
      for (let c = 0; c < modules; c += 1) {
        const dark = code.isDark(r, c);
        const bx = qx + c * SUB;
        const by = qy + r * SUB;
        if (fmap[r * modules + c]) {
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
    return { width, height, bits, color, layout, version: layout.version, modules, scale: SUB };
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
    return Math.max(2, Math.min(8, Math.floor((maxSide || 2600) / longest)));
  }

  return { render, toRGBA, suggestedScale, functionMap, plan, config, SUB, QUIET, LEVEL };
});
