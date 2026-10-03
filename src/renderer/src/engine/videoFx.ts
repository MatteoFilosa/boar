import { type EventFx, fxParam } from '../core/fx'

// Video FX in WebGL2: the event is drawn on a 2D canvas, uploaded as a texture,
// run through the effect passes (ping-pong framebuffers) and drawn back. Colors
// stay premultiplied by alpha, like the 2D canvas.

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

// vUv (0,0) is the bottom-left corner of the picture (textures are uploaded flipped).
const HEADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform sampler2D uOrig;
uniform vec2 uRes;
uniform float uTime;
uniform float uScale;
uniform float uV[12];
uniform sampler2D uAux;
/** Person confidence (Remove Background); the mask is stored top row first. */
float personAt(vec2 uv) { return texture(uAux, vec2(uv.x, 1.0 - uv.y)).r; }

vec4 tex(vec2 uv) { return texture(uTex, uv); }
vec4 texSafe(vec2 uv) {
  return (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? vec4(0.0) : texture(uTex, uv);
}
vec3 unpremul(vec4 c) { return c.a > 0.0001 ? c.rgb / c.a : vec3(0.0); }
vec4 premul(vec3 rgb, float a) { return vec4(clamp(rgb, 0.0, 1.0) * a, a); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise1(float x) {
  float i = floor(x);
  float f = fract(x);
  return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f)) * 2.0 - 1.0;
}
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
vec3 adjust(vec3 rgb, float contrast, float saturation) {
  rgb = (rgb - 0.5) * (1.0 + contrast) + 0.5;
  return mix(vec3(luma(rgb)), rgb, 1.0 + saturation);
}
/** Position in units of the short side, centered on c (given top-left based). */
vec2 local(vec2 uv, vec2 c) {
  vec2 cc = vec2(c.x, 1.0 - c.y);
  return (uv - cc) * uRes / min(uRes.x, uRes.y);
}
vec2 unlocal(vec2 p, vec2 c) {
  vec2 cc = vec2(c.x, 1.0 - c.y);
  return cc + p * min(uRes.x, uRes.y) / uRes;
}
`

const PROGRAMS: Record<string, string> = {
  copy: `void main() { outColor = tex(vUv); }`,

  bgCut: `void main() {
    vec4 c = tex(vUv);
    float a = smoothstep(uV[0] - uV[1], uV[0] + uV[1], personAt(vUv));
    outColor = c * a;
  }`,

  bgMix: `void main() {
    vec4 person = texture(uOrig, vUv);
    vec4 back = tex(vUv);
    float a = smoothstep(uV[0] - uV[1], uV[0] + uV[1], personAt(vUv));
    outColor = mix(back, person, a);
  }`,

  bgGrade: `void main() {
    vec4 c = tex(vUv);
    vec3 rgb = unpremul(c);
    vec3 back = uV[2] < 2.5 ? rgb * 0.35 : vec3(luma(rgb));
    float a = smoothstep(uV[0] - uV[1], uV[0] + uV[1], personAt(vUv));
    outColor = premul(mix(back, rgb, a), c.a);
  }`,

  sepia: `void main() {
    vec4 c = tex(vUv); vec3 rgb = unpremul(c);
    vec3 s = vec3(dot(rgb, vec3(0.393, 0.769, 0.189)), dot(rgb, vec3(0.349, 0.686, 0.168)), dot(rgb, vec3(0.272, 0.534, 0.131)));
    outColor = premul(mix(rgb, s, uV[0]), c.a);
  }`,

  blackWhite: `void main() {
    vec4 c = tex(vUv); vec3 rgb = unpremul(c);
    outColor = premul(mix(rgb, vec3(luma(rgb)), uV[0]), c.a);
  }`,

  negative: `void main() {
    vec4 c = tex(vUv); vec3 rgb = unpremul(c);
    outColor = premul(mix(rgb, 1.0 - rgb, uV[0]), c.a);
  }`,

  colorCorrector: `void main() {
    vec4 c = tex(vUv); vec3 rgb = unpremul(c);
    rgb *= exp2(uV[0]);
    rgb += uV[1] * 0.5;
    rgb = adjust(rgb, uV[2], uV[3]);
    rgb = pow(max(rgb, 0.0), vec3(1.0 / max(uV[4], 0.01)));
    if (abs(uV[5]) > 0.01) { vec3 h = rgb2hsv(clamp(rgb, 0.0, 1.0)); h.x = fract(h.x + uV[5] / 360.0); rgb = hsv2rgb(h); }
    rgb += vec3(uV[6] * 0.12, uV[6] * 0.03, -uV[6] * 0.12);
    rgb += vec3(uV[7] * 0.06, -uV[7] * 0.1, uV[7] * 0.06);
    outColor = premul(rgb, c.a);
  }`,

  look: `void main() {
    vec4 c = tex(vUv); vec3 rgb = unpremul(c); vec3 o = rgb;
    int look = int(uV[0] + 0.5);
    float l = luma(rgb);
    if (look == 0) { o = adjust(rgb, 0.15, 0.35); }
    else if (look == 1) { o = adjust(rgb + vec3(0.07, 0.02, -0.06), 0.05, 0.1); }
    else if (look == 2) { o = adjust(rgb + vec3(-0.06, 0.0, 0.08), 0.05, -0.05); }
    else if (look == 3) { o = adjust(rgb, -0.15, -0.3) * 0.86 + 0.09; }
    else if (look == 4) {
      o = rgb + mix(vec3(-0.06, 0.03, 0.09), vec3(0.09, 0.02, -0.07), smoothstep(0.15, 0.85, l));
      o = adjust(o, 0.12, 0.12);
    }
    else if (look == 5) {
      vec3 s = vec3(dot(rgb, vec3(0.393, 0.769, 0.189)), dot(rgb, vec3(0.349, 0.686, 0.168)), dot(rgb, vec3(0.272, 0.534, 0.131)));
      o = mix(rgb, s, 0.45);
      o = adjust(o, -0.1, -0.15) * 0.88 + vec3(0.08, 0.06, 0.03);
    }
    else if (look == 6) { o = vec3(clamp((l - 0.5) * 1.45 + 0.5, 0.0, 1.0)); }
    else if (look == 7) {
      o = rgb + mix(vec3(-0.03, 0.02, 0.05), vec3(0.05, 0.01, -0.03), l);
      o = adjust(o, 0.18, -0.12);
      o = max(o - 0.03, 0.0) * 1.03;
    }
    else if (look == 8) { o = adjust(rgb, -0.2, -0.2) * 0.8 + vec3(0.17, 0.15, 0.18); }
    else if (look == 9) { o = adjust(rgb * vec3(1.08, 0.98, 0.84) + vec3(0.05, 0.02, 0.0), 0.08, 0.15); }
    outColor = premul(mix(rgb, o, uV[1]), c.a);
  }`,

  colorize: `void main() {
    vec4 c = tex(vUv); vec3 rgb = unpremul(c);
    vec3 tint = mix(vec3(1.0), hsv2rgb(vec3(uV[0] / 360.0, 1.0, 1.0)), uV[1]);
    vec3 t = tint * luma(rgb) / max(luma(tint), 0.05);
    outColor = premul(mix(rgb, t, uV[2]), c.a);
  }`,

  posterize: `void main() {
    vec4 c = tex(vUv); vec3 rgb = unpremul(c);
    float n = max(uV[0] - 1.0, 1.0);
    outColor = premul(floor(rgb * n + 0.5) / n, c.a);
  }`,

  chromaKey: `void main() {
    vec4 c = tex(vUv); vec3 rgb = unpremul(c);
    vec3 hsv = rgb2hsv(clamp(rgb, 0.0, 1.0));
    float dh = abs(fract(hsv.x - uV[0] / 360.0 + 0.5) - 0.5) * 2.0;
    float d = dh + (1.0 - smoothstep(0.12, 0.35, hsv.y)) + (1.0 - smoothstep(0.08, 0.25, hsv.z));
    float a = smoothstep(uV[1], uV[1] + uV[2] + 0.001, d);
    float spill = uV[3] * (1.0 - smoothstep(0.0, uV[1] + uV[2] + 0.25, dh)) * smoothstep(0.1, 0.3, hsv.y);
    rgb = mix(rgb, vec3(luma(rgb)), clamp(spill, 0.0, 1.0));
    outColor = premul(rgb, c.a * a);
  }`,

  blur: `void main() {
    float r = uV[0];
    if (r < 0.5) { outColor = tex(vUv); return; }
    vec2 dir = vec2(uV[1], uV[2]) / uRes;
    const int N = 14;
    float stepPx = max(1.0, r / float(N));
    float sigma = max(r * 0.5, 0.5);
    vec4 sum = vec4(0.0); float wsum = 0.0;
    for (int i = -N; i <= N; i++) {
      float x = float(i) * stepPx;
      float w = exp(-0.5 * x * x / (sigma * sigma));
      sum += texture(uTex, vUv + dir * x) * w;
      wsum += w;
    }
    outColor = sum / wsum;
  }`,

  sharpen: `void main() {
    vec2 px = 1.0 / uRes;
    vec4 c = tex(vUv);
    vec4 n = tex(vUv + vec2(px.x, 0.0)) + tex(vUv - vec2(px.x, 0.0)) + tex(vUv + vec2(0.0, px.y)) + tex(vUv - vec2(0.0, px.y));
    vec4 o = c + (c - n * 0.25) * uV[0];
    outColor = vec4(clamp(o.rgb, 0.0, c.a), c.a);
  }`,

  brightPass: `void main() {
    vec4 c = tex(vUv);
    float l = luma(unpremul(c));
    outColor = c * smoothstep(uV[0], uV[0] + 0.15, l);
  }`,

  glowAdd: `void main() {
    vec4 o = texture(uOrig, vUv);
    vec4 g = tex(vUv) * uV[0];
    vec3 rgb = min(o.rgb + g.rgb, vec3(1.0));
    outColor = vec4(rgb, max(o.a, max(rgb.r, max(rgb.g, rgb.b))));
  }`,

  radialBlur: `void main() {
    vec2 c = vec2(uV[1], 1.0 - uV[2]);
    vec2 d = vUv - c;
    vec4 sum = vec4(0.0);
    const int N = 28;
    for (int i = 0; i < N; i++) {
      float s = 1.0 - uV[0] * 0.45 * float(i) / float(N - 1);
      sum += texture(uTex, c + d * s);
    }
    outColor = sum / float(N);
  }`,

  vignette: `void main() {
    vec4 c = tex(vUv);
    float d = length(vUv - 0.5) / 0.7071;
    float r0 = mix(0.35, 1.15, uV[1]);
    float f = mix(0.05, 0.9, uV[2]);
    float k = 1.0 - uV[0] * smoothstep(r0 - f, r0, d);
    outColor = vec4(c.rgb * k, c.a);
  }`,

  grain: `void main() {
    vec4 c = tex(vUv); vec3 rgb = unpremul(c);
    vec2 cell = floor(vUv * uRes / max(1.0, uV[1] * uScale));
    float n = hash12(cell + floor(uTime * 24.0) * vec2(17.13, 3.71)) - 0.5;
    float l = luma(rgb);
    rgb += n * uV[0] * (0.35 + 0.5 * (1.0 - abs(l - 0.5) * 2.0));
    outColor = premul(rgb, c.a);
  }`,

  vhs: `void main() {
    float a = uV[0];
    float t = uTime;
    float row = floor(vUv.y * uRes.y / 3.0);
    float jitter = (hash12(vec2(row, floor(t * 30.0))) - 0.5) * 0.004 * a;
    float wobble = sin(vUv.y * 40.0 + t * 4.0) * 0.0015 * a;
    float tracking = smoothstep(0.985, 1.0, 1.0 - abs(fract(vUv.y * 0.5 - t * 0.12) - 0.5) * 2.0);
    vec2 uv = vUv + vec2(jitter + wobble + tracking * 0.02 * a, 0.0);
    vec2 bleed = vec2(0.005 * a, 0.0);
    vec4 cg = texSafe(uv);
    vec4 cr = texSafe(uv + bleed);
    vec4 cb = texSafe(uv - bleed);
    vec4 col = vec4(cr.r, cg.g, cb.b, max(cg.a, max(cr.a, cb.a)));
    vec3 rgb = unpremul(col);
    rgb = mix(rgb, adjust(rgb, -0.1, -0.25) + vec3(0.03, 0.0, 0.04), a);
    rgb *= mix(1.0, 0.82 + 0.18 * sin(vUv.y * uRes.y * 1.4), a);
    rgb += (hash12(vUv * uRes + t * 97.0) - 0.5) * 0.12 * a + tracking * 0.25 * a;
    outColor = premul(rgb, col.a);
  }`,

  glitch: `void main() {
    float a = uV[0];
    float t = floor(uTime * uV[1] * 3.0);
    float band = floor(vUv.y * 22.0);
    float burst = step(1.0 - a * 0.7, hash12(vec2(t, 1.7)));
    float h = hash12(vec2(band, t));
    float shift = burst * step(1.0 - a * 0.6, h) * (hash12(vec2(t, band + 7.0)) - 0.5) * 0.18 * a;
    vec2 uv = vUv + vec2(shift, 0.0);
    float split = burst * a * 0.015 + a * 0.002;
    vec4 cr = texSafe(uv + vec2(split, 0.0));
    vec4 cg = texSafe(uv);
    vec4 cb = texSafe(uv - vec2(split, 0.0));
    outColor = vec4(cr.r, cg.g, cb.b, max(cg.a, max(cr.a, cb.a)));
  }`,

  chromatic: `void main() {
    float ang = radians(uV[1]);
    vec2 o = vec2(cos(ang), sin(ang)) * uV[0] * uScale / uRes;
    vec4 cr = texSafe(vUv + o);
    vec4 cg = tex(vUv);
    vec4 cb = texSafe(vUv - o);
    outColor = vec4(cr.r, cg.g, cb.b, max(cg.a, max(cr.a, cb.a)));
  }`,

  pixelate: `void main() {
    vec2 b = max(1.0, uV[0] * uScale) / uRes;
    outColor = texture(uTex, (floor(vUv / b) + 0.5) * b);
  }`,

  mirror: `void main() {
    vec2 uv = vUv;
    int m = int(uV[0] + 0.5);
    if (m == 0) uv.x = uv.x > 0.5 ? 1.0 - uv.x : uv.x;
    else if (m == 1) uv.x = uv.x < 0.5 ? 1.0 - uv.x : uv.x;
    else if (m == 2) uv.y = uv.y < 0.5 ? 1.0 - uv.y : uv.y;
    else if (m == 3) uv.y = uv.y > 0.5 ? 1.0 - uv.y : uv.y;
    else if (m == 4) uv = vec2(uv.x > 0.5 ? 1.0 - uv.x : uv.x, uv.y < 0.5 ? 1.0 - uv.y : uv.y);
    else if (m == 5) uv.x = 1.0 - uv.x;
    else uv.y = 1.0 - uv.y;
    outColor = tex(uv);
  }`,

  shake: `void main() {
    float t = uTime * uV[1];
    vec2 off = vec2(noise1(t), noise1(t + 31.7)) * 0.035 * uV[0];
    float rot = noise1(t + 71.3) * 0.04 * uV[0];
    float aspect = uRes.x / uRes.y;
    vec2 p = vUv - 0.5;
    p.x *= aspect;
    p = mat2(cos(rot), -sin(rot), sin(rot), cos(rot)) * p;
    p.x /= aspect;
    p /= max(uV[2], 0.01);
    outColor = texSafe(p + 0.5 + off);
  }`,

  spherize: `void main() {
    vec2 c = vec2(uV[2], uV[3]);
    vec2 p = local(vUv, c);
    float R = max(uV[1], 0.001);
    float d = length(p);
    if (d < R) {
      float k = pow(d / R, uV[0] * 1.2);
      p *= k;
    }
    outColor = texSafe(unlocal(p, c));
  }`,

  twirl: `void main() {
    vec2 c = vec2(uV[2], uV[3]);
    vec2 p = local(vUv, c);
    float R = max(uV[1], 0.001);
    float d = length(p);
    if (d < R) {
      float k = 1.0 - d / R;
      float ang = radians(uV[0]) * k * k;
      p = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * p;
    }
    outColor = texSafe(unlocal(p, c));
  }`,

  wave: `void main() {
    vec2 uv = vUv;
    float ph = uTime * uV[2] * 6.2832;
    if (uV[3] < 0.5) uv.x += sin(vUv.y * uV[1] * 6.2832 + ph) * uV[0];
    else uv.y += sin(vUv.x * uV[1] * 6.2832 + ph) * uV[0];
    outColor = texSafe(uv);
  }`
}

// Transitions mix the outgoing frame (uTex) into the incoming one (uOrig) as
// uV[0] goes 0 -> 1. On a plain cut both are the same clip's frame, so each
// type is written to also look right with a single picture (zoom punch, whip...).
const TRANSITION_HELPERS = `
vec2 mirrorUv(vec2 uv) { return 1.0 - abs(1.0 - mod(uv, 2.0)); }
float ease(float p) { return p * p * (3.0 - 2.0 * p); }
vec4 zoomBlur(sampler2D t, vec2 uv, float s, float blur) {
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    float k = s * (1.0 + blur * 0.08 * float(i) / 11.0);
    sum += texture(t, mirrorUv(0.5 + (uv - 0.5) / k));
  }
  return sum / 12.0;
}
`

const TRANSITIONS: Record<string, string> = {
  zoomIn: `void main() {
    float p = uV[0];
    if (p < 0.5) { float q = ease(p * 2.0); outColor = zoomBlur(uTex, vUv, 1.0 + q * 1.8, q * 3.0); }
    else { float q = ease((1.0 - p) * 2.0); outColor = zoomBlur(uOrig, vUv, 1.0 + q * 1.8, q * 3.0); }
  }`,
  zoomOut: `void main() {
    float p = uV[0];
    if (p < 0.5) { float q = ease(p * 2.0); outColor = zoomBlur(uTex, vUv, 1.0 / (1.0 + q * 1.2), q * 3.0); }
    else { float q = ease((1.0 - p) * 2.0); outColor = zoomBlur(uOrig, vUv, 1.0 / (1.0 + q * 1.2), q * 3.0); }
  }`,
  whip: `void main() {
    float p = uV[0];
    vec2 dir = vec2(uV[1], uV[2]);
    float e = ease(p);
    float spread = 0.28 * sin(p * 3.14159);
    vec4 sum = vec4(0.0);
    for (int i = 0; i < 16; i++) {
      vec2 s = vUv + dir * (e + spread * (float(i) / 15.0 - 0.5));
      bool inFrom = s.x >= 0.0 && s.y >= 0.0 && s.x < 1.0 && s.y < 1.0;
      sum += inFrom ? texture(uTex, s) : texture(uOrig, mirrorUv(s - dir));
    }
    outColor = sum / 16.0;
  }`,
  spin: `void main() {
    float p = uV[0];
    float aspect = uRes.x / uRes.y;
    float a = (p < 0.5 ? ease(p * 2.0) : -ease((1.0 - p) * 2.0)) * 3.14159;
    float z = 1.0 + sin(p * 3.14159) * 0.6;
    vec4 sum = vec4(0.0);
    for (int i = 0; i < 10; i++) {
      float ai = a * (1.0 - 0.06 * float(i) * sin(p * 3.14159));
      vec2 q = (vUv - 0.5) * vec2(aspect, 1.0);
      q = mat2(cos(ai), -sin(ai), sin(ai), cos(ai)) * q / z;
      vec2 uv = mirrorUv(q / vec2(aspect, 1.0) + 0.5);
      sum += p < 0.5 ? texture(uTex, uv) : texture(uOrig, uv);
    }
    outColor = sum / 10.0;
  }`,
  glitch: `void main() {
    float p = uV[0];
    float k = sin(p * 3.14159);
    float t = floor(p * 24.0);
    float band = floor(vUv.y * 18.0);
    float shift = (hash12(vec2(band, t)) - 0.5) * 0.25 * k * step(0.4, hash12(vec2(t, band + 3.0)));
    vec2 uv = vec2(vUv.x + shift, vUv.y);
    vec2 split = vec2(0.03 * k, 0.0);
    bool to = p > 0.5 + (hash12(vec2(band, t + 9.0)) - 0.5) * 0.3 * k;
    vec4 a = to ? texture(uOrig, mirrorUv(uv + split)) : texture(uTex, mirrorUv(uv + split));
    vec4 b = to ? texture(uOrig, mirrorUv(uv)) : texture(uTex, mirrorUv(uv));
    vec4 c = to ? texture(uOrig, mirrorUv(uv - split)) : texture(uTex, mirrorUv(uv - split));
    outColor = vec4(a.r, b.g, c.b, max(a.a, max(b.a, c.a)));
  }`,
  flash: `void main() {
    float p = uV[0];
    vec4 c = p < 0.5 ? tex(vUv) : texture(uOrig, vUv);
    float f = pow(1.0 - abs(p * 2.0 - 1.0), 1.6);
    outColor = vec4(mix(c.rgb, vec3(c.a), f), c.a);
  }`,
  dipBlack: `void main() {
    float p = uV[0];
    vec4 c = p < 0.5 ? tex(vUv) : texture(uOrig, vUv);
    float f = 1.0 - pow(1.0 - abs(p * 2.0 - 1.0), 0.8);
    outColor = vec4(c.rgb * f, c.a);
  }`,
  blur: `void main() {
    float p = uV[0];
    float r = sin(p * 3.14159) * 0.025;
    vec4 a = vec4(0.0);
    vec4 b = vec4(0.0);
    for (int x = -3; x <= 3; x++) for (int y = -3; y <= 3; y++) {
      vec2 o = vec2(float(x), float(y)) * r / 3.0 * vec2(uRes.y / uRes.x, 1.0);
      a += texture(uTex, mirrorUv(vUv + o));
      b += texture(uOrig, mirrorUv(vUv + o));
    }
    outColor = mix(a, b, smoothstep(0.35, 0.65, p)) / 49.0;
  }`,
  pixelate: `void main() {
    float p = uV[0];
    float k = sin(p * 3.14159);
    float cells = mix(400.0, 12.0, k);
    vec2 size = vec2(uRes.y / uRes.x, 1.0) / cells;
    vec2 uv = (floor(vUv / size) + 0.5) * size;
    outColor = p < 0.5 ? texture(uTex, uv) : texture(uOrig, uv);
  }`
}

/** Transition types: the shader and its direction. */
export const TRANSITION_TYPES: Record<string, { program: string; dir?: [number, number] }> = {
  zoomIn: { program: 'zoomIn' },
  zoomOut: { program: 'zoomOut' },
  whipLeft: { program: 'whip', dir: [1, 0] },
  whipRight: { program: 'whip', dir: [-1, 0] },
  whipUp: { program: 'whip', dir: [0, -1] },
  whipDown: { program: 'whip', dir: [0, 1] },
  spin: { program: 'spin' },
  glitch: { program: 'glitch' },
  flash: { program: 'flash' },
  dipBlack: { program: 'dipBlack' },
  blur: { program: 'blur' },
  pixelate: { program: 'pixelate' }
}

interface Pass {
  program: keyof typeof PROGRAMS
  values: number[]
}

/** The passes of one effect. `scale` converts px-at-1080p parameters to output pixels. */
function passesFor(fx: EventFx, scale: number, hasMask: boolean): Pass[] {
  const p = (key: string): number => fxParam(fx, key)
  switch (fx.type) {
    case 'removeBg': {
      // Without a mask yet (model loading) the picture passes through unchanged.
      if (!hasMask) return []
      const edge = [p('threshold'), p('softness')]
      const mode = Math.round(p('mode'))
      if (mode === 0) return [{ program: 'bgCut', values: edge }]
      if (mode === 1) {
        const r = p('blur') * scale
        return [
          { program: 'blur', values: [r, 1, 0] },
          { program: 'blur', values: [r, 0, 1] },
          { program: 'bgMix', values: edge }
        ]
      }
      return [{ program: 'bgGrade', values: [...edge, mode] }]
    }
    case 'sepia':
    case 'blackWhite':
    case 'negative':
      return [{ program: fx.type, values: [p('amount')] }]
    case 'colorCorrector':
      return [
        {
          program: 'colorCorrector',
          values: [p('exposure'), p('brightness'), p('contrast'), p('saturation'), p('gamma'), p('hue'), p('temperature'), p('tint')]
        }
      ]
    case 'look':
      return [{ program: 'look', values: [p('look'), p('intensity')] }]
    case 'colorize':
      return [{ program: 'colorize', values: [p('hue'), p('saturation'), p('amount')] }]
    case 'posterize':
      return [{ program: 'posterize', values: [p('levels')] }]
    case 'chromaKey':
      return [{ program: 'chromaKey', values: [p('hue'), p('tolerance'), p('softness'), p('spill')] }]
    case 'blur': {
      const r = p('radius') * scale
      return [
        { program: 'blur', values: [r, 1, 0] },
        { program: 'blur', values: [r, 0, 1] }
      ]
    }
    case 'sharpen':
      return [{ program: 'sharpen', values: [p('amount')] }]
    case 'glow': {
      const r = p('radius') * scale
      return [
        { program: 'brightPass', values: [p('threshold')] },
        { program: 'blur', values: [r, 1, 0] },
        { program: 'blur', values: [r, 0, 1] },
        { program: 'glowAdd', values: [p('intensity')] }
      ]
    }
    case 'radialBlur':
      return [{ program: 'radialBlur', values: [p('amount'), p('cx'), p('cy')] }]
    case 'vignette':
      return [{ program: 'vignette', values: [p('amount'), p('size'), p('softness')] }]
    case 'grain':
      return [{ program: 'grain', values: [p('amount'), p('size')] }]
    case 'vhs':
      return [{ program: 'vhs', values: [p('amount')] }]
    case 'glitch':
      return [{ program: 'glitch', values: [p('amount'), p('speed')] }]
    case 'chromatic':
      return [{ program: 'chromatic', values: [p('amount'), p('angle')] }]
    case 'pixelate':
      return [{ program: 'pixelate', values: [p('size')] }]
    case 'mirror':
      return [{ program: 'mirror', values: [p('mode')] }]
    case 'shake':
      return [{ program: 'shake', values: [p('amount'), p('speed'), p('zoom')] }]
    case 'spherize':
      return [{ program: 'spherize', values: [p('amount'), p('radius'), p('cx'), p('cy')] }]
    case 'twirl':
      return [{ program: 'twirl', values: [p('angle'), p('radius'), p('cx'), p('cy')] }]
    case 'wave':
      return [{ program: 'wave', values: [p('amplitude'), p('frequency'), p('speed'), p('direction')] }]
    default:
      return []
  }
}

interface Target {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
}

interface ProgramInfo {
  program: WebGLProgram
  uTex: WebGLUniformLocation | null
  uOrig: WebGLUniformLocation | null
  uRes: WebGLUniformLocation | null
  uTime: WebGLUniformLocation | null
  uScale: WebGLUniformLocation | null
  uV: WebGLUniformLocation | null
  uAux: WebGLUniformLocation | null
}

class FxRenderer {
  readonly canvas = new OffscreenCanvas(16, 16)
  private readonly gl: WebGL2RenderingContext
  private readonly programs = new Map<string, ProgramInfo>()
  private readonly source: WebGLTexture
  private readonly second: WebGLTexture
  private readonly aux: WebGLTexture
  private targets: Target[] = []
  private width = 0
  private height = 0
  lost = false

  constructor() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      antialias: false,
      depth: false,
      stencil: false
    })
    if (!gl) throw new Error('WebGL2 is not available')
    this.gl = gl
    this.canvas.addEventListener('webglcontextlost', () => (this.lost = true))
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    this.source = this.makeTexture()
    this.second = this.makeTexture()
    this.aux = this.makeTexture()
  }

  private makeTexture(): WebGLTexture {
    const gl = this.gl
    const tex = gl.createTexture() as WebGLTexture
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  }

  private compile(name: string): ProgramInfo {
    const cached = this.programs.get(name)
    if (cached) return cached
    const gl = this.gl
    const shader = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type) as WebGLShader
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader ${name}: ${gl.getShaderInfoLog(s)}`)
      return s
    }
    const program = gl.createProgram() as WebGLProgram
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERT))
    const body = PROGRAMS[name] ?? (TRANSITIONS[name] ? TRANSITION_HELPERS + TRANSITIONS[name] : undefined)
    if (!body) throw new Error(`Unknown program ${name}`)
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, HEADER + body))
    gl.bindAttribLocation(program, 0, 'aPos')
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Program ${name}: ${gl.getProgramInfoLog(program)}`)
    const info: ProgramInfo = {
      program,
      uTex: gl.getUniformLocation(program, 'uTex'),
      uOrig: gl.getUniformLocation(program, 'uOrig'),
      uRes: gl.getUniformLocation(program, 'uRes'),
      uTime: gl.getUniformLocation(program, 'uTime'),
      uScale: gl.getUniformLocation(program, 'uScale'),
      uV: gl.getUniformLocation(program, 'uV'),
      uAux: gl.getUniformLocation(program, 'uAux')
    }
    this.programs.set(name, info)
    return info
  }

  private resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return
    const gl = this.gl
    this.width = width
    this.height = height
    this.canvas.width = width
    this.canvas.height = height
    for (const t of this.targets) {
      gl.deleteTexture(t.tex)
      gl.deleteFramebuffer(t.fbo)
    }
    this.targets = []
    for (let i = 0; i < 3; i++) {
      const tex = this.makeTexture()
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      const fbo = gl.createFramebuffer() as WebGLFramebuffer
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      this.targets.push({ tex, fbo })
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /** One transition pass: `from` (outgoing) into `to` (incoming) at progress p (0..1). */
  transition(from: TexImageSource, to: TexImageSource, type: string, p: number, width: number, height: number): OffscreenCanvas | null {
    const spec = TRANSITION_TYPES[type]
    if (!spec) return null
    const gl = this.gl
    this.resize(width, height)
    gl.viewport(0, 0, width, height)
    gl.disable(gl.BLEND)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.source)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, from)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.second)
    if (to === from) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, from)
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, to)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    const info = this.compile(spec.program)
    gl.useProgram(info.program)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.uniform1i(info.uTex, 0)
    gl.uniform1i(info.uOrig, 1)
    gl.uniform2f(info.uRes, width, height)
    gl.uniform1f(info.uTime, 0)
    gl.uniform1f(info.uScale, Math.min(width, height) / 1080)
    const values = new Float32Array(12)
    values[0] = Math.min(1, Math.max(0, p))
    values[1] = spec.dir?.[0] ?? 0
    values[2] = spec.dir?.[1] ?? 0
    gl.uniform1fv(info.uV, values)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    return this.canvas
  }

  run(source: TexImageSource, fx: EventFx[], width: number, height: number, time: number, mask?: VideoFxMask | null): OffscreenCanvas | null {
    const gl = this.gl
    const scale = Math.min(width, height) / 1080
    const effects = fx.map((f) => passesFor(f, scale, !!mask)).filter((p) => p.length > 0)
    if (effects.length === 0) return null
    if (mask) {
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, this.aux)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mask.width, mask.height, 0, gl.RED, gl.UNSIGNED_BYTE, mask.data)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    }
    this.resize(width, height)
    gl.viewport(0, 0, width, height)
    gl.disable(gl.BLEND)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.source)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    let current: WebGLTexture = this.source
    const total = effects.reduce((n, e) => n + e.length, 0)
    let done = 0
    for (const passes of effects) {
      const effectInput = current
      for (const pass of passes) {
        done++
        const last = done === total
        const target = last ? null : this.targets.find((t) => t.tex !== current && t.tex !== effectInput) ?? null
        const info = this.compile(pass.program)
        gl.useProgram(info.program)
        gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, current)
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, effectInput)
        gl.uniform1i(info.uTex, 0)
        gl.uniform1i(info.uOrig, 1)
        gl.uniform1i(info.uAux, 2)
        gl.uniform2f(info.uRes, width, height)
        gl.uniform1f(info.uTime, time)
        gl.uniform1f(info.uScale, scale)
        const values = new Float32Array(12)
        values.set(pass.values.slice(0, 12))
        gl.uniform1fv(info.uV, values)
        if (last) {
          gl.clearColor(0, 0, 0, 0)
          gl.clear(gl.COLOR_BUFFER_BIT)
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        if (target) current = target.tex
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return this.canvas
  }
}

let renderer: FxRenderer | null = null
let failed = false
const reported = new Set<string>()

/**
 * Runs the effect chain on `source` (an output-sized frame) and returns a
 * canvas with the result, or null when there is nothing to do or no WebGL2.
 */
/** A single-channel mask for effects that need one (Remove Background), top row first. */
export interface VideoFxMask {
  data: Uint8Array
  width: number
  height: number
}

export function applyVideoFx(
  source: TexImageSource,
  fx: EventFx[],
  width: number,
  height: number,
  time: number,
  mask?: VideoFxMask | null
): OffscreenCanvas | null {
  if (fx.length === 0 || failed) return null
  try {
    if (!renderer || renderer.lost) renderer = new FxRenderer()
    return renderer.run(source, fx, width, height, time, mask)
  } catch (err) {
    // No WebGL2 at all disables the effects; a single broken shader only skips this frame.
    if (!renderer) failed = true
    const message = err instanceof Error ? err.message : String(err)
    if (!reported.has(message)) {
      reported.add(message)
      console.error('[videoFx]', message)
    }
    return null
  }
}

/** Renders a transition frame (see TRANSITION_TYPES); null without WebGL2. */
export function applyTransition(from: TexImageSource, to: TexImageSource, type: string, p: number, width: number, height: number): OffscreenCanvas | null {
  if (failed) return null
  try {
    if (!renderer || renderer.lost) renderer = new FxRenderer()
    return renderer.transition(from, to, type, p, width, height)
  } catch (err) {
    if (!renderer) failed = true
    const message = err instanceof Error ? err.message : String(err)
    if (!reported.has(message)) {
      reported.add(message)
      console.error('[videoFx]', message)
    }
    return null
  }
}
