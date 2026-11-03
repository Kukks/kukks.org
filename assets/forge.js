// Pixel-art fluid fire: a WebGL2 heat/smoke solver run at art resolution and upscaled
// nearest-neighbour by CSS. The KUKKS wordmark is the fuel. In deck mode the page never
// scrolls: wheel, swipe and keys burn the current slide away and assemble the next in place.
(() => {
  const root = document.documentElement;
  const canvas = document.getElementById('fire');
  const mark = document.querySelector('.wordmark');
  const hero = document.querySelector('.hero');
  const pauseBtn = document.getElementById('pause');
  const slides = [...document.querySelectorAll('.slide')].map((el) => ({ el }));
  const pager = [...document.querySelectorAll('.pager button')];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Tuning knobs. Units: art pixels, seconds.
  const K = {
    iters: 20, vorticity: 26, buoyancy: 85, smokeWeight: 8, velDiss: 0.5,
    cooling: 0.95, smokeGen: 0.3, smokeDiss: 0.65, letterHeat: 1.2, floor: 0.3,
    stir: 14, burst: 140, sparkRate: 24, scrollCarry: 0.85,
    burnTime: 0.45, formDelay: 0.12, formTime: 0.45,
  };

  const GLYPHS = {
    K: ['XX...XX', 'XX..XX.', 'XX.XX..', 'XXXX...', 'XXX....', 'XXXX...', 'XX.XX..', 'XX..XX.', 'XX...XX'],
    U: ['XX...XX', 'XX...XX', 'XX...XX', 'XX...XX', 'XX...XX', 'XX...XX', 'XX...XX', 'XXXXXXX', '.XXXXX.'],
    S: ['.XXXXXX', 'XXXXXXX', 'XX.....', 'XXXXXX.', '.XXXXXX', '.....XX', '.....XX', 'XXXXXXX', 'XXXXXX.'],
  };
  const WORD = 'KUKKS', GW = 7, GH = 9, GAP = 2, BW = WORD.length * (GW + GAP) - GAP;

  let raf = 0;
  const unmask = (s) => { s.el.style.maskImage = s.el.style.webkitMaskImage = ''; };
  const off = () => {
    cancelAnimationFrame(raf);
    root.classList.remove('fire', 'deck');
    mark.style.width = mark.style.height = '';
    for (const el of document.querySelectorAll('.slide, .hero .quick')) {
      unmask({ el });
      el.style.translate = '';
      el.classList.remove('gone');
    }
  };

  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
  if (!gl) return off();
  gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');

  const FIRE = `const vec3 FIRE[8] = vec3[8](vec3(.251, 0., 0.), vec3(.502, .031, 0.), vec3(.769, .118, .039),
    vec3(1., .251, .063), vec3(1., .502, .125), vec3(1., .698, .2), vec3(1., .851, .4), vec3(1., 1., .784));`;
  const VS = `#version 300 es
    layout(location = 0) in vec2 aPos;
    void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;
  const HEAD = `#version 300 es
    precision highp float;
    precision highp int;
    precision highp sampler2D;
    out vec4 o;
    ivec2 C() { return ivec2(gl_FragCoord.xy); }
    vec4 at(sampler2D t, ivec2 c) { return texelFetch(t, clamp(c, ivec2(0), textureSize(t, 0) - 1), 0); }
    float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f *= f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
    }
    // A transitioning slide's threshold under this pixel (r = left col, top row, w, h in art px; H = canvas rows), or -1 outside it.
    float slideThr(sampler2D t, vec4 r, ivec2 c, int H, bool form) {
      ivec2 l = ivec2(c.x - int(r.x), H - 1 - c.y - int(r.y));
      if (any(lessThan(l, ivec2(0))) || any(greaterThanEqual(l, ivec2(r.zw)))) return -1.0;
      vec4 v = texelFetch(t, l, 0);
      return form ? v.g : v.r;
    }
    // Three burn slots (old slide, new slide, header chips): texture, rect, (progress or -1 when idle, 1 if assembling).
    uniform sampler2D uB0, uB1, uB2;
    uniform vec4 uBR0, uBR1, uBR2;
    uniform vec2 uBP0, uBP1, uBP2;
  `;

  const CURL = HEAD + `
    uniform sampler2D uVel;
    void main() {
      ivec2 c = C();
      float L = at(uVel, c - ivec2(1, 0)).y, R = at(uVel, c + ivec2(1, 0)).y;
      float B = at(uVel, c - ivec2(0, 1)).x, T = at(uVel, c + ivec2(0, 1)).x;
      o = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
    }`;

  const FORCES = HEAD + `
    uniform sampler2D uVel, uCurl, uField;
    uniform float uDt, uVort, uBuoy, uWeight;
    void main() {
      ivec2 c = C();
      float L = abs(at(uCurl, c - ivec2(1, 0)).x), R = abs(at(uCurl, c + ivec2(1, 0)).x);
      float B = abs(at(uCurl, c - ivec2(0, 1)).x), T = abs(at(uCurl, c + ivec2(0, 1)).x);
      vec2 f = vec2(T - B, R - L);
      f *= uVort * at(uCurl, c).x / (length(f) + 1e-4) * vec2(1.0, -1.0);
      vec4 s = at(uField, c);
      o = vec4(at(uVel, c).xy + (f + vec2(0.0, s.x * uBuoy - s.y * uWeight)) * uDt, 0.0, 1.0);
    }`;

  const SPLAT = HEAD + `
    uniform sampler2D uSrc;
    uniform vec2 uPoint;
    uniform vec4 uValue;
    uniform float uR, uRadial;
    void main() {
      vec2 d = gl_FragCoord.xy - uPoint;
      vec4 add = uRadial > 0.5 ? vec4(d / (length(d) + 1e-3) * uValue.x, 0.0, 0.0) : uValue;
      o = texelFetch(uSrc, C(), 0) + add * exp(-dot(d, d) / uR);
    }`;

  const SOURCES = HEAD + `
    uniform sampler2D uField, uMask;
    uniform vec2 uOrigin;
    uniform float uIgn[5];
    uniform float uTime, uHeat, uFloor, uDissolve;
    float front(sampler2D t, vec4 r, vec2 pm, ivec2 c) {
      if (pm.x < 0.0 || pm.y > 0.5) return 0.0;
      float d = pm.x - slideThr(t, r, c, textureSize(uField, 0).y, false);
      return d > 0.0 && d < 0.06 ? 0.9 : 0.0;
    }
    void main() {
      ivec2 c = C(), m = c - ivec2(uOrigin);
      vec4 f = texelFetch(uField, c, 0);
      if (all(greaterThanEqual(m, ivec2(0))) && all(lessThan(m, textureSize(uMask, 0)))) {
        vec4 v = texelFetch(uMask, m, 0);
        if (v.y > 0.0 && v.z > uDissolve) f.x = max(f.x, uIgn[clamp(int(v.x * 7.97 + 0.5) - 1, 0, 4)] * uHeat
          * (0.6 + 0.8 * noise(vec2(c) * 0.4 - vec2(0.0, uTime * 6.0))));
      }
      f.x = max(f.x, max(front(uB0, uBR0, uBP0, c), max(front(uB1, uBR1, uBP1, c), front(uB2, uBR2, uBP2, c))));
      if (c.y < 2) f.x = max(f.x, uFloor * smoothstep(0.45, 1.0, noise(vec2(float(c.x) * 0.15, uTime * 0.8))));
      o = f;
    }`;

  const DIVERGENCE = HEAD + `
    uniform sampler2D uVel;
    void main() {
      ivec2 c = C(), s = textureSize(uVel, 0) - 1;
      vec2 v = at(uVel, c).xy;
      float L = c.x > 0 ? at(uVel, c - ivec2(1, 0)).x : -v.x;
      float R = c.x < s.x ? at(uVel, c + ivec2(1, 0)).x : -v.x;
      float B = c.y > 0 ? at(uVel, c - ivec2(0, 1)).y : -v.y;
      float T = c.y < s.y ? at(uVel, c + ivec2(0, 1)).y : v.y;
      o = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
    }`;

  // The top edge is open (pressure 0) so heat and smoke leave the screen instead of pooling.
  const PRESSURE = HEAD + `
    uniform sampler2D uP, uDiv;
    void main() {
      ivec2 c = C(), s = textureSize(uP, 0) - 1;
      float T = c.y < s.y ? at(uP, c + ivec2(0, 1)).x : 0.0;
      float p = at(uP, c - ivec2(1, 0)).x + at(uP, c + ivec2(1, 0)).x + at(uP, c - ivec2(0, 1)).x + T;
      o = vec4((p - at(uDiv, c).x) * 0.25, 0.0, 0.0, 1.0);
    }`;

  const GRADIENT = HEAD + `
    uniform sampler2D uP, uVel;
    void main() {
      ivec2 c = C(), s = textureSize(uP, 0) - 1;
      float T = c.y < s.y ? at(uP, c + ivec2(0, 1)).x : 0.0;
      float L = at(uP, c - ivec2(1, 0)).x, R = at(uP, c + ivec2(1, 0)).x, B = at(uP, c - ivec2(0, 1)).x;
      o = vec4(at(uVel, c).xy - 0.5 * vec2(R - L, T - B), 0.0, 1.0);
    }`;

  // uLift carries the fluid along with page scroll; samples beyond the top/bottom edge read as empty.
  const BACKTRACE = `
    uniform float uLift;
    vec4 back(sampler2D src, vec2 v, float dt) {
      vec2 res = vec2(textureSize(src, 0)), p = gl_FragCoord.xy - dt * v - vec2(0.0, uLift);
      return p.y < -1.0 || p.y > res.y + 1.0 ? vec4(0.0) : texture(src, p / res);
    }`;

  const ADVECT = HEAD + BACKTRACE + `
    uniform sampler2D uVel, uSrc;
    uniform float uDt, uDiss;
    void main() {
      o = vec4(back(uSrc, texelFetch(uVel, C(), 0).xy, uDt).xy / (1.0 + uDiss * uDt), 0.0, 1.0);
    }`;

  // Noisy cooling that scrolls upward with the flames carves them into tongues; lost heat becomes smoke.
  const ADVECT_FIELD = HEAD + BACKTRACE + `
    uniform sampler2D uVel, uSrc;
    uniform float uDt, uCool, uSmoke, uSmokeDiss, uTime;
    void main() {
      vec4 f = back(uSrc, texelFetch(uVel, C(), 0).xy, uDt);
      float n = noise(gl_FragCoord.xy * vec2(0.21, 0.13) - vec2(0.0, uTime * 5.0));
      float h = max(f.x - uCool * (0.3 + 1.4 * n) * uDt, 0.0);
      o = vec4(h, (f.y + (f.x - h) * uSmoke) / (1.0 + uSmokeDiss * uDt), 0.0, 1.0);
    }`;

  // Mask texel: r = letter id, g = top-exposed (emits heat), b = dissolve threshold.
  const DISPLAY = HEAD + FIRE + `
    const vec3 SMOKE[3] = vec3[3](vec3(.07, .063, .106), vec3(.118, .106, .153), vec3(.188, .169, .22));
    const float BAYER[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
    uniform sampler2D uField, uMask;
    uniform vec2 uOrigin, uShift;
    uniform float uIgn[5];
    uniform float uTime, uDissolve, uStars;
    vec4 mtex(ivec2 m) {
      return any(lessThan(m, ivec2(0))) || any(greaterThanEqual(m, textureSize(uMask, 0))) ? vec4(0.0) : texelFetch(uMask, m, 0);
    }
    float mask(ivec2 m) { vec4 v = mtex(m); return v.z > uDissolve ? v.x : 0.0; }
    float glyph(ivec2 m) { return mtex(m).x; }
    int ramp(float v, float b) { return int(floor(v * 8.0 + b - 0.5)); }
    // Just-burnt pixels glow through the holes they leave; pixels about to assemble heat up first.
    vec3 glow(sampler2D t, vec4 r, vec2 pm, ivec2 c, float b, vec3 col) {
      if (pm.x < 0.0) return col;
      bool form = pm.y > 0.5;
      float th = slideThr(t, r, c, textureSize(uField, 0).y, form);
      float w = form ? 0.15 : 0.18, d = form ? th - pm.x : pm.x - th;
      if (th < 0.0 || d <= 0.0 || d >= w) return col;
      int k = ramp(1.0 - d / w, b);
      return k >= 0 ? FIRE[min(k, 7)] : col;
    }
    void main() {
      ivec2 c = C();
      vec2 res = vec2(textureSize(uField, 0));
      float b = (BAYER[(c.y & 3) * 4 + (c.x & 3)] + 0.5) / 16.0;
      float y = gl_FragCoord.y / res.y;
      vec3 col = vec3(0.0, 0.0, floor(clamp((y - 0.2) / 0.8, 0.0, 1.0) * 3.0 + b) * 0.0367);
      float s = hash(vec2(c - ivec2(0, int(uStars))) + 0.5);
      if (s > 0.996 && y > 0.3) col = sin(uTime * (0.4 + 3.0 * fract(s * 97.0)) + s * 500.0) > 0.2 ? vec3(.72, .75, .92) : vec3(.23, .25, .42);
      // Floor embers (bottom 16 rows) stay put when a paused frame is shifted.
      ivec2 fc = c.y < 16 ? c : c - ivec2(uShift);
      bool floorCopy = c.y >= 16 && fc.y < 16 && uShift.y != 0.0;
      vec4 f = floorCopy || any(lessThan(fc, ivec2(0))) || any(greaterThanEqual(fc, ivec2(res))) ? vec4(0.0) : texelFetch(uField, fc, 0);
      int si = int(floor(f.y * 3.0 + b - 1.0));
      if (si >= 0) col = SMOKE[min(si, 2)];
      int fi = int(floor(f.x * 9.0 + b - 1.0));
      if (fi >= 0) col = FIRE[min(fi, 7)];
      col = glow(uB2, uBR2, uBP2, c, b, glow(uB1, uBR1, uBP1, c, b, glow(uB0, uBR0, uBP0, c, b, col)));
      ivec2 m = c - ivec2(uOrigin);
      vec4 t = mtex(m);
      if (t.z > uDissolve && t.x > 0.0) {
        float h = 0.6 + 0.2 * noise(vec2(c) * vec2(0.5, 0.35) + vec2(uTime * 0.7, -uTime * 2.5))
          + 0.32 * float(m.y) / float(textureSize(uMask, 0).y);
        if (mask(m + ivec2(0, 1)) == 0.0) h += 0.2;
        if (mask(m - ivec2(0, 1)) == 0.0) h -= 0.25;
        if (mask(m + ivec2(1, 0)) == 0.0 || mask(m - ivec2(1, 0)) == 0.0) h -= 0.1;
        int li = int(floor(h * uIgn[clamp(int(t.x * 7.97 + 0.5) - 1, 0, 4)] * 9.0 + b - 1.0));
        col = li >= 0 ? FIRE[min(li, 7)] : vec3(.133, .125, .192);
        if (uDissolve > 0.0 && t.z - uDissolve < 0.06) col = FIRE[b > 0.5 ? 7 : 6];
      } else if (t.x > 0.0) {
        // Burnt-out pixels stay as scorched charcoal (ashier toward the top) with smouldering cracks.
        float n = noise(vec2(c) * 0.55 + vec2(0.0, uTime * 0.6));
        float g = 0.55 * noise(vec2(c) * 0.45) + 0.45 * hash(vec2(c) * 1.7) + 0.35 * float(m.y) / float(textureSize(uMask, 0).y) - 0.15;
        col = n > 0.8 ? FIRE[n > 0.9 ? 2 : 1] : g > 0.62 ? vec3(.38, .3, .27) : g > 0.38 ? vec3(.24, .18, .16) : vec3(.13, .09, .09);
      } else if (glyph(m + ivec2(1, 0)) + glyph(m - ivec2(1, 0)) + glyph(m + ivec2(0, 1)) + glyph(m - ivec2(0, 1))
          + glyph(m + ivec2(1, 1)) + glyph(m - ivec2(1, 1)) + glyph(m + ivec2(1, -1)) + glyph(m + ivec2(-1, 1)) > 0.0) {
        col = vec3(.078, .016, .016);
      }
      o = vec4(col, 1.0);
    }`;

  const POINT_VS = `#version 300 es
    layout(location = 0) in vec3 aP;
    uniform vec2 uRes;
    out float vLife;
    void main() {
      vLife = aP.z;
      gl_Position = vec4((floor(aP.xy) + 0.5) / uRes * 2.0 - 1.0, 0.0, 1.0);
      gl_PointSize = 1.0;
    }`;
  const POINT_FS = `#version 300 es
    precision highp float;
    in float vLife;
    out vec4 o;
    ${FIRE}
    void main() { o = vec4(FIRE[clamp(int(vLife * 7.0) + 1, 1, 7)], 1.0); }`;

  function program(fs, vs = VS) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    for (let i = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i--;) {
      const name = gl.getActiveUniform(p, i).name.replace('[0]', '');
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  let P, W, H, S, MW, MH, tops = [], pix = [], maskTex, targets = [], vel, field, pres, curl, div;
  let curlP, forceP, splatP, sourceP, divP, presP, gradP, advectP, fieldP, displayP, pointP, quad, points, pbuf;

  function run(prog, target, uniforms) {
    gl.useProgram(prog.p);
    let unit = 0;
    for (const k in uniforms) {
      const loc = prog.u[k], v = uniforms[k];
      if (loc == null) continue;
      if (v.tex) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, v.tex);
        gl.uniform1i(loc, unit++);
      } else if (typeof v === 'number') gl.uniform1f(loc, v);
      else if (v instanceof Float32Array) gl.uniform1fv(loc, v);
      else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
      else gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, W, H);
    gl.bindVertexArray(quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function texture(w, h, data) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return { tex };
  }

  function target() {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, W, H, 0, gl.RGBA, gl.HALF_FLOAT, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('float render targets unsupported');
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    targets.push({ tex, fbo });
    return targets.at(-1);
  }

  function pair() {
    let a = target(), b = target();
    return { get read() { return a; }, get write() { return b; }, swap() { [a, b] = [b, a]; } };
  }

  const splat = (p, point, value, r, radial = 0) => {
    run(splatP, p.write, { uSrc: p.read, uPoint: point, uValue: value, uR: r, uRadial: radial });
    p.swap();
  };

  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;width:0;height:100lvh;visibility:hidden;pointer-events:none';
  document.body.append(probe);

  // Sized to the large viewport so mobile URL-bar show/hide never resets the simulation.
  // Phones get chunkier pixels so the wordmark spans ~90% of the width at glyph scale 2.
  let deck = false;
  function layout() {
    const before = [P, W, H, S].join();
    const narrow = innerWidth < 720;
    P = narrow ? Math.max(3, Math.floor(innerWidth * 0.9 / (BW * 2))) : Math.min(Math.max(Math.round(innerWidth / 260), 3), 10);
    W = Math.ceil(innerWidth / P);
    H = Math.ceil(Math.max(probe.offsetHeight, innerHeight) / P);
    S = Math.max(1, Math.min(narrow ? 2 : Math.floor(W * 0.78 / BW), Math.floor(H * (deck ? 0.2 : 0.26) / GH)));
    return before !== [P, W, H, S].join();
  }

  // Dissolve thresholds sweep left to right and top to bottom with grain, so the word crumbles like it is blown.
  function buildMask() {
    MW = BW * S;
    MH = GH * S;
    const data = new Uint8Array(MW * MH * 4);
    tops = [];
    pix = [];
    [...WORD].forEach((ch, i) => GLYPHS[ch].forEach((row, gy) => [...row].forEach((px, gx) => {
      if (px !== 'X') return;
      const x0 = (i * (GW + GAP) + gx) * S, y0 = (GH - 1 - gy) * S;
      const exposed = gy === 0 || GLYPHS[ch][gy - 1][gx] !== 'X';
      for (let y = y0; y < y0 + S; y++) {
        for (let x = x0; x < x0 + S; x++) {
          const thr = Math.min(254, Math.max(1, Math.round(255 * (0.4 * x / MW + 0.2 * (1 - y / MH) + 0.4 * Math.random()))));
          data.set([(i + 1) * 32, exposed ? 255 : 0, thr, 255], (y * MW + x) * 4);
          pix.push([x, y, thr / 255]);
          if (exposed && y === y0 + S - 1) tops.push([x, y + 1, i, thr / 255]);
        }
      }
    })));
    pix.sort((a, b) => a[2] - b[2]);
    dissolved = -1;
    if (maskTex) gl.deleteTexture(maskTex.tex);
    maskTex = texture(MW, MH, data);
    mark.style.width = MW * P + 'px';
    mark.style.height = MH * P + 'px';
  }

  function rebuild() {
    for (const t of targets) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    targets = [];
    sparks = [];
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = W * P + 'px';
    canvas.style.height = H * P + 'px';
    vel = pair();
    field = pair();
    pres = pair();
    curl = target();
    div = target();
  }

  let origin = [0, 0];
  const track = () => {
    const r = mark.getBoundingClientRect();
    origin = [Math.round(r.left / P), H - Math.round(r.top / P) - MH];
  };

  const MAX_SPARKS = 1500, sbuf = new Float32Array(MAX_SPARKS * 3);
  let sparks = [], sparkAcc = 0;
  function spawn(x, y, n, spread, rise, decay = 0.5 + Math.random() * 0.9) {
    while (n-- > 0 && sparks.length < MAX_SPARKS) {
      const a = Math.random() * 6.283, s = Math.random() * spread;
      sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s + rise, life: 1, decay });
    }
  }
  // A seeking spark flies in a straight line and lands on (x, y) after T seconds, brightening as it arrives.
  function seek(x, y, T) {
    if (sparks.length >= MAX_SPARKS) return;
    const a = Math.random() * 6.283, r = 8 + Math.random() * 18;
    sparks.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r, vx: -Math.cos(a) * r / T, vy: -Math.sin(a) * r / T, life: 1, decay: 1 / T, seek: true });
  }
  function moveSparks(dt) {
    for (sparkAcc += dt * K.sparkRate; sparkAcc >= 1; sparkAcc--) {
      const [x, y, i, thr] = tops[(Math.random() * tops.length) | 0];
      if (ign[i] === 1 && thr > dissolve) spawn(origin[0] + x + Math.random(), origin[1] + y, 1, 6, 12);
    }
    sparks = sparks.filter((s) => {
      if (!s.seek) {
        s.vx = (s.vx + (Math.random() - 0.5) * 160 * dt) * (1 - 1.5 * dt);
        s.vy += 16 * dt;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.life -= s.decay * dt;
      return s.life > 0 && s.y < H && s.y >= 0 && s.x >= 0 && s.x < W;
    });
  }
  function drawSparks(shiftY) {
    if (!sparks.length) return;
    sparks.forEach((s, i) => sbuf.set([s.x, s.y + shiftY, s.seek ? 1.15 - s.life : s.life], i * 3));
    gl.useProgram(pointP.p);
    gl.uniform2f(pointP.u.uRes, W, H);
    gl.bindVertexArray(points);
    gl.bindBuffer(gl.ARRAY_BUFFER, pbuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, sbuf, 0, sparks.length * 3);
    gl.drawArrays(gl.POINTS, 0, sparks.length);
  }

  let meteor = null, meteorIn = 4 + Math.random() * 4;
  function moveMeteor(dt) {
    if (!meteor && (meteorIn -= dt) < 0) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      meteor = {
        x: W * (dir > 0 ? 0.05 + 0.4 * Math.random() : 0.55 + 0.4 * Math.random()), y: H * (0.78 + 0.18 * Math.random()),
        vx: dir * (110 + 70 * Math.random()), vy: -(30 + 40 * Math.random()), t: 0.7 + 0.6 * Math.random(),
      };
    }
    if (!meteor) return;
    const { x, y } = meteor;
    meteor.x += meteor.vx * dt;
    meteor.y += meteor.vy * dt;
    for (let n = Math.ceil(Math.hypot(meteor.x - x, meteor.y - y)), i = 1; i <= n; i++) {
      spawn(x + (meteor.x - x) * i / n, y + (meteor.y - y) * i / n, 1, 2, 0, 2.2 + Math.random());
    }
    if ((meteor.t -= dt) < 0) {
      meteor = null;
      meteorIn = 7 + Math.random() * 10;
    }
  }

  const ign = new Float32Array(5);
  function ignite() {
    for (let i = 0; i < 5; i++) {
      const was = ign[i];
      ign[i] = Math.min(Math.max((t - 0.4 - 0.18 * i) / 0.5, 0), 1);
      if (!was && ign[i]) for (const [x, y, li] of tops) if (li === i && Math.random() < 0.3) spawn(origin[0] + x, origin[1] + y, 1, 26, 18);
    }
  }

  // The wordmark burns to charcoal and re-forms on the way back: in the deck it burns down one step per slide
  // like a fuse, fully charred on the second-to-last and reborn on the last; in the scrolling page it follows the hero.
  let dissolve = 0, dissolved = -1;
  function burnName(dt) {
    let target;
    if (deck) target = cur === lastSlide ? 0 : cur / (lastSlide - 1);
    else {
      const hr = hero.getBoundingClientRect(), hp = Math.min(Math.max(-hr.top / (hr.height * 0.7), 0), 1);
      target = paused || reduced ? 0 : hp * hp * (3 - 2 * hp);
    }
    dissolve = deck && dt ? dissolve + (target - dissolve) * Math.min(1, dt * 4) : target;
    let k = Math.max(dissolved, 0);
    while (k < pix.length && pix[k][2] <= dissolve) k++;
    while (k > 0 && pix[k - 1][2] > dissolve) k--;
    if (dissolved >= 0 && k > dissolved && dt) {
      const keep = 300 / Math.max(300, k - dissolved);
      for (let j = dissolved; j < k; j++) {
        if (Math.random() < keep) spawn(origin[0] + pix[j][0], origin[1] + pix[j][1], 1, 22, 20);
      }
    }
    dissolved = k;
  }

  // ---- Deck: slides stack in one grid cell. Slides and the header link chips are "burnables": each can
  // burn away or assemble in place, a pixel mask hiding the DOM while the same thresholds drive the GL glow. ----

  const chips = { el: document.querySelector('.hero .quick'), chip: true, shown: true };
  const stageEl = document.querySelector('.stage');
  const burnables = [...slides, chips];
  const lastSlide = slides.length - 1;
  let cur = 0, queued = 0, flare = 0, stars = 0, smoulder = 2.5, rebirth = false;
  let wheelAt = 0, wheelPrev = 0, wheelPeak = 0, wheelSum = 0, wheelFired = false;
  const wantDeck = () => !reduced && innerHeight >= 500;
  const busy = () => slides.some((s) => s.anim);
  // Input arriving mid-transition is remembered and played as soon as the slides settle.
  const nav = (dir) => (busy() ? (queued = dir) : go(cur + dir));

  const nextBtn = document.querySelector('.next');
  const names = slides.map((s) => s.el.getAttribute('aria-label'));
  function syncUi() {
    pager.forEach((b, k) => b.setAttribute('aria-current', k === cur));
    root.classList.toggle('last', cur === lastSlide);
    nextBtn.querySelector('.go-name').textContent = names[cur === lastSlide ? 0 : cur + 1];
  }

  const quantize = (f) => {
    let lo = Infinity, hi = -Infinity;
    for (const v of f) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    return f.map((v) => (1 + Math.round(253 * (v - lo) / (hi - lo || 1))) / 255);
  };
  const order = (f) => Uint32Array.from(f.keys()).sort((a, b) => f[a] - f[b]);

  // Burn thresholds grow from the top (flames lick up through the part already gone); assembly grows from the centre.
  function fields(w, h) {
    const gw = (w >> 3) + 2, gh = (h >> 3) + 2, g1 = new Float32Array(gw * gh), g2 = new Float32Array(gw * gh);
    for (let i = 0; i < gw * gh; i++) {
      g1[i] = Math.random();
      g2[i] = Math.random();
    }
    const vn = (g, x, y) => {
      const X = x / 8, Y = y / 8, i = X | 0, j = Y | 0, fx = X - i, fy = Y - j, k = j * gw + i;
      return (g[k] * (1 - fx) + g[k + 1] * fx) * (1 - fy) + (g[k + gw] * (1 - fx) + g[k + gw + 1] * fx) * fy;
    };
    const burn = new Float32Array(w * h), form = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        burn[y * w + x] = 0.5 * y / h + 0.4 * vn(g1, x, y) + 0.1 * Math.random();
        form[y * w + x] = 0.78 * Math.hypot(x / w - 0.5, y / h - 0.5) + 0.35 * vn(g2, x, y) + 0.1 * Math.random();
      }
    }
    return [quantize(burn), quantize(form)];
  }

  // Each burnable is snapped onto the fire's pixel grid so its mask pixels line up with the glow drawn behind it.
  function layoutBurnables() {
    if (!deck) return;
    root.style.setProperty('--lift', `${stageEl.getBoundingClientRect().top - chips.el.getBoundingClientRect().top}px`);
    for (const s of slides) {
      s.el.classList.remove('tight');
      if (s.el.scrollHeight > s.el.clientHeight + 1) s.el.classList.add('tight');
    }
    for (const b of burnables) b.el.style.translate = '';
    const rects = burnables.map((b) => b.el.getBoundingClientRect());
    burnables.forEach((b, i) => {
      const r = rects[i];
      b.x0 = Math.round(r.left / P);
      b.y0 = Math.round(r.top / P);
      b.el.style.translate = `${b.x0 * P - r.left}px ${b.y0 * P - r.top}px`;
      b.w = Math.max(1, Math.ceil(r.width / P));
      b.h = Math.max(1, Math.ceil(r.height / P));
      [b.burn, b.form] = fields(b.w, b.h);
      b.burnOrder = order(b.burn);
      b.formOrder = order(b.form);
      const data = new Uint8Array(b.w * b.h * 4);
      b.burn.forEach((v, k) => data.set([Math.round(v * 255), Math.round(b.form[k] * 255), 0, 255], k * 4));
      if (b.tex) gl.deleteTexture(b.tex.tex);
      b.tex = texture(b.w, b.h, data);
      b.canvas ||= document.createElement('canvas');
      b.canvas.width = b.w;
      b.canvas.height = b.h;
      b.ctx = b.canvas.getContext('2d');
      b.img = b.ctx.createImageData(b.w, b.h);
      b.img.data.fill(255);
      b.el.style.maskSize = b.el.style.webkitMaskSize = `${b.w * P}px ${b.h * P}px`;
      if (b.anim) Object.assign(b.anim, { k: 0, quiet: true });
    });
  }

  function paint(b, f, p, burning) {
    const a = b.img.data;
    for (let i = 0; i < f.length; i++) a[i * 4 + 3] = (f[i] > p) === burning ? 255 : 0;
    b.ctx.putImageData(b.img, 0, 0);
    b.el.style.maskImage = b.el.style.webkitMaskImage = `url(${b.canvas.toDataURL()})`;
  }

  const texel = (b, k) => [b.x0 + (k % b.w) + 0.5, H - b.y0 - Math.floor(k / b.w) - 0.5];

  function show(b, on) {
    b.shown = on;
    if (b.chip) b.el.classList.toggle('gone', !on);
    else b.el.classList.toggle('on', on);
  }

  function animate(b, mode, delay) {
    b.anim = { mode, t: -delay, p: 0, k: 0 };
    show(b, true);
    if (mode === 'burn' && !b.chip) b.el.classList.add('out');
    paint(b, mode === 'burn' ? b.burn : b.form, 0, mode === 'burn');
  }

  function settle(b) {
    const a = b.anim;
    if (!a) return;
    b.anim = null;
    unmask(b);
    b.el.classList.remove('out');
    if (a.mode === 'burn') show(b, false);
  }

  function go(i) {
    i = Math.max(0, Math.min(lastSlide, i));
    queued = 0;
    if (!deck || i === cur) return;
    burnables.forEach(settle);
    const from = cur;
    cur = i;
    syncUi();
    root.classList.add('moved');
    // The header chips duplicate the contact slide, so they burn away while it is up.
    const chipsWanted = cur !== lastSlide;
    if (paused) {
      show(slides[from], false);
      show(slides[i], true);
      show(chips, chipsWanted);
      return render();
    }
    animate(slides[from], 'burn', 0);
    animate(slides[i], 'form', K.formDelay);
    if (chipsWanted !== chips.shown) animate(chips, chipsWanted ? 'form' : 'burn', chipsWanted ? K.formDelay : 0);
    flare = 0.8;
    for (let n = 0; n < 40 && tops.length; n++) {
      const [x, y] = tops[(Math.random() * tops.length) | 0];
      spawn(origin[0] + x, origin[1] + y, 1, 20, 26);
    }
    if (i === lastSlide) rebirth = true;
  }

  function tickDeck(dt) {
    stars += (cur * 40 - stars) * Math.min(1, dt * 3);
    flare *= Math.exp(-dt * 3);
    // Until the visitor first moves, the next button smoulders so the way forward is hard to miss.
    if (deck && !root.classList.contains('moved') && (smoulder -= dt) < 0) {
      smoulder = 1.8;
      const r = nextBtn.getBoundingClientRect();
      for (let n = 0; n < 10; n++) spawn((r.left + Math.random() * r.width) / P, H - r.top / P, 1, 6, 14);
    }
    for (const b of burnables) {
      const a = b.anim;
      if (!a) continue;
      const quiet = a.quiet, burning = a.mode === 'burn', f = burning ? b.burn : b.form, ord = burning ? b.burnOrder : b.formOrder;
      a.quiet = false;
      a.t += dt;
      a.p = Math.min(Math.max(a.t / (burning ? K.burnTime : K.formTime), 0), 1);
      paint(b, f, a.p, burning);
      if (burning) {
        const keep = (b.chip ? 250 : 700) / f.length;
        for (; a.k < f.length && f[ord[a.k]] <= a.p; a.k++) if (!quiet && Math.random() < keep) spawn(...texel(b, ord[a.k]), 1, 14, 18);
      } else {
        // Seekers launch 0.2s before their pixel forms so they land on it as it appears.
        const keep = (b.chip ? 300 : 800) / f.length, horizon = (a.t + 0.2) / K.formTime;
        for (; a.k < f.length && f[ord[a.k]] <= horizon; a.k++) {
          const k = ord[a.k];
          if (!quiet && Math.random() < keep) seek(...texel(b, k), Math.max(f[k] * K.formTime - a.t, 0.05));
        }
      }
      if (a.p >= 1) settle(b);
    }
    if (queued && !busy()) go(cur + queued);
  }

  // Up to three animating burnables feed the GL glow and heat slots.
  function burnUniforms() {
    const u = {}, live = burnables.filter((b) => b.anim);
    for (let j = 0; j < 3; j++) {
      const b = live[j];
      u['uB' + j] = b ? b.tex : maskTex;
      u['uBR' + j] = b ? [b.x0, b.y0, b.w, b.h] : [0, 0, 0, 0];
      u['uBP' + j] = b ? [b.anim.p, b.anim.mode === 'form' ? 1 : 0] : [-1, 0];
    }
    return u;
  }

  function setDeck(on) {
    burnables.forEach(settle);
    deck = on;
    root.classList.toggle('deck', on);
    slides.forEach((s, i) => show(s, i === cur));
    show(chips, !on || cur !== lastSlide);
    for (const b of burnables) b.el.style.translate = '';
    if (on) scrollTo(0, 0);
  }

  const ptr = { x: 0, y: 0, dx: 0, dy: 0, on: false };
  const bursts = [];
  let t = 0;
  function step(dt, lift = 0) {
    t += dt;
    const tt = t % 600;
    ignite();
    run(curlP, curl, { uVel: vel.read });
    run(forceP, vel.write, { uVel: vel.read, uCurl: curl, uField: field.read, uDt: dt, uVort: K.vorticity, uBuoy: K.buoyancy, uWeight: K.smokeWeight });
    vel.swap();
    if (ptr.dx || ptr.dy) {
      splat(vel, [ptr.x, ptr.y], [ptr.dx * K.stir, ptr.dy * K.stir, 0, 0], 24);
      splat(field, [ptr.x, ptr.y], [Math.min(Math.hypot(ptr.dx, ptr.dy) * 0.04, 0.5), 0, 0, 0], 6);
      ptr.dx = ptr.dy = 0;
    }
    for (const [x, y] of bursts.splice(0)) {
      splat(vel, [x, y], [K.burst, 0, 0, 0], 40, 1);
      splat(field, [x, y], [1.5, 0.3, 0, 0], 20);
      spawn(x, y, 36, 70, 10);
    }
    // Phoenix: arriving on the last slide, the charred name re-ignites with a fireball, an updraft and a plume.
    if (rebirth) {
      rebirth = false;
      flare = 2.2;
      for (let n = 0; n < 6; n++) splat(field, [origin[0] + MW * (n + 0.5) / 6, origin[1] + MH * 0.7], [1.3, 0, 0, 0], 40);
      splat(vel, [origin[0] + MW / 2, origin[1] + MH], [0, 110, 0, 0], 600);
      for (let n = 0; n < 240 && tops.length; n++) {
        const [x, y] = tops[(Math.random() * tops.length) | 0];
        spawn(origin[0] + x, origin[1] + y, 1, 36, 70);
      }
    }
    run(sourceP, field.write, {
      uField: field.read, uMask: maskTex, uOrigin: origin, uIgn: ign, uTime: tt, uHeat: K.letterHeat * (1 + flare),
      uFloor: K.floor, uDissolve: dissolve, ...burnUniforms(),
    });
    field.swap();
    run(divP, div, { uVel: vel.read });
    for (let i = 0; i < K.iters; i++) {
      run(presP, pres.write, { uP: pres.read, uDiv: div });
      pres.swap();
    }
    run(gradP, vel.write, { uP: pres.read, uVel: vel.read });
    vel.swap();
    run(advectP, vel.write, { uVel: vel.read, uSrc: vel.read, uDt: dt, uDiss: K.velDiss, uLift: lift });
    vel.swap();
    run(fieldP, field.write, { uVel: vel.read, uSrc: field.read, uDt: dt, uCool: K.cooling, uSmoke: K.smokeGen, uSmokeDiss: K.smokeDiss, uTime: tt, uLift: lift });
    field.swap();
    for (const s of sparks) s.y += lift;
    moveMeteor(dt);
    moveSparks(dt);
  }

  // While paused, the frozen frame is shifted so flames stay glued to the scrolling wordmark.
  let paused = false, frozenAt = 0, last = 0, lastScroll = scrollY;
  function render() {
    const shift = paused ? origin[1] - frozenAt : 0;
    run(displayP, null, {
      uField: field.read, uMask: maskTex, uOrigin: origin, uShift: [0, shift], uIgn: ign,
      uTime: t % 600, uDissolve: dissolve, uStars: deck ? stars : scrollY / P * 0.25, ...burnUniforms(),
    });
    drawSparks(shift);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    try {
      const dt = Math.min(Math.max((now - last) / 1000, 0), 1 / 30);
      const lift = (scrollY - lastScroll) / P * K.scrollCarry;
      last = now;
      lastScroll = scrollY;
      track();
      burnName(dt);
      tickDeck(dt);
      step(dt, lift);
      render();
    } catch (e) {
      console.warn('Fire disabled:', e.message);
      off();
    }
  }

  function setPaused(p) {
    paused = p;
    root.classList.toggle('paused', p);
    pauseBtn.setAttribute('aria-pressed', p);
    cancelAnimationFrame(raf);
    frozenAt = origin[1];
    if (p) burnables.forEach(settle);
    burnName(0);
    if (p) render();
    else {
      last = performance.now();
      lastScroll = scrollY;
      raf = requestAnimationFrame(frame);
    }
  }

  try {
    [curlP, forceP, splatP, sourceP, divP, presP, gradP, advectP, fieldP, displayP] =
      [CURL, FORCES, SPLAT, SOURCES, DIVERGENCE, PRESSURE, GRADIENT, ADVECT, ADVECT_FIELD, DISPLAY].map((fs) => program(fs));
    pointP = program(POINT_FS, POINT_VS);

    quad = gl.createVertexArray();
    gl.bindVertexArray(quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    points = gl.createVertexArray();
    gl.bindVertexArray(points);
    pbuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pbuf);
    gl.bufferData(gl.ARRAY_BUFFER, sbuf.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    setDeck(wantDeck());
    layout();
    buildMask();
    rebuild();
    track();
    layoutBurnables();
    if (deck) {
      animate(slides[0], 'form', 0.25);
      animate(chips, 'form', 0.45);
    }
  } catch (e) {
    console.warn('Fire disabled:', e.message);
    return off();
  }

  addEventListener('pointermove', (e) => {
    const x = e.clientX / P, y = H - e.clientY / P;
    if (ptr.on) {
      ptr.dx += x - ptr.x;
      ptr.dy += y - ptr.y;
    }
    Object.assign(ptr, { x, y, on: true });
  }, { passive: true });
  addEventListener('pointerdown', (e) => {
    Object.assign(ptr, { x: e.clientX / P, y: H - e.clientY / P, on: true });
    if (!paused && e.isPrimary && !e.target.closest('a, button, .slab')) bursts.push([ptr.x, ptr.y]);
  }, { passive: true });
  addEventListener('pointerout', (e) => {
    if (!e.relatedTarget) ptr.on = false;
  }, { passive: true });
  addEventListener('scroll', () => {
    if (paused) {
      track();
      burnName(0);
      render();
    }
  }, { passive: true });

  // Deck input: one wheel gesture fires one transition as soon as it has moved 20px. The rest of that
  // gesture (trackpad momentum included) is ignored; a new gesture starts after a 160ms pause or when
  // deltas climb again while momentum is dying. A slide that still overflows scrolls inside itself first.
  const canScroll = (el, dir) => (dir > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : dir < 0 && el.scrollTop > 0);
  addEventListener('wheel', (e) => {
    if (!deck || e.ctrlKey) return;
    e.preventDefault();
    const now = performance.now(), dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? innerHeight : 1);
    const mag = Math.abs(dy);
    if (now - wheelAt > 160 || (wheelPrev < wheelPeak * 0.6 && mag > wheelPrev * 1.6 + 3)) {
      wheelSum = wheelPeak = 0;
      wheelFired = false;
    }
    wheelAt = now;
    wheelPrev = mag;
    wheelPeak = Math.max(wheelPeak, mag);
    const s = slides[cur].el;
    if (!busy() && !wheelFired && canScroll(s, Math.sign(dy))) return void (s.scrollTop += dy);
    wheelSum += dy;
    if (wheelFired || Math.abs(wheelSum) < 20) return;
    wheelFired = true;
    nav(Math.sign(wheelSum));
  }, { passive: false });

  addEventListener('keydown', (e) => {
    if (!deck || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      return go(e.key === 'Home' ? 0 : slides.length - 1);
    }
    const dir = { ArrowDown: 1, PageDown: 1, ArrowUp: -1, PageUp: -1, ' ': e.shiftKey ? -1 : 1 }[e.key];
    if (!dir || (e.key === ' ' && e.target.closest('a, button'))) return;
    e.preventDefault();
    const s = slides[cur].el;
    if (e.key.startsWith('Arrow') && canScroll(s, dir)) return void (s.scrollTop += dir * 40);
    nav(dir);
  });

  let touch = null;
  addEventListener('touchstart', (e) => {
    const s = slides[cur].el;
    touch = deck && e.touches.length === 1
      ? { y: e.touches[0].clientY, inside: s.contains(e.target), up: canScroll(s, -1), down: canScroll(s, 1) } : null;
  }, { passive: true });
  addEventListener('touchmove', (e) => {
    if (!touch || e.touches.length > 1) return;
    const dy = touch.y - e.touches[0].clientY;
    if (!(touch.inside && (dy > 0 ? touch.down : touch.up))) e.preventDefault();
  }, { passive: false });
  addEventListener('touchend', (e) => {
    const tc = touch;
    touch = null;
    if (!tc) return;
    const dy = tc.y - e.changedTouches[0].clientY;
    if (Math.abs(dy) > 45 && !(tc.inside && (dy > 0 ? tc.down : tc.up))) nav(Math.sign(dy));
  }, { passive: true });

  pager.forEach((b, i) => b.addEventListener('click', () => go(i)));
  nextBtn.addEventListener('click', () => (cur === slides.length - 1 ? go(0) : nav(1)));
  addEventListener('focusin', (e) => {
    const i = slides.findIndex((s) => s.el.contains(e.target));
    if (deck && i >= 0 && i !== cur) go(i);
  });

  let resizeTimer = 0;
  const relayout = () => {
    if (wantDeck() !== deck) setDeck(!deck);
    if (layout()) {
      buildMask();
      rebuild();
    }
    track();
    layoutBurnables();
    if (paused) render();
  };
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(relayout, 150);
  });
  document.fonts?.ready.then(relayout);

  pauseBtn.addEventListener('click', () => setPaused(!paused));
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    off();
  });

  if (reduced) {
    for (let i = 0; i < 200; i++) step(1 / 60);
    sparks = [];
    setPaused(true);
  } else setPaused(false);
})();
