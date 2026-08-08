#include <flutter/runtime_effect.glsl>

// Stage 1, revision B, 2026-08-08 — the raymarched material, ported
// from a real, working Kimi prototype (read directly, not trusted
// blind — full evaluation in DECISIONS.md). Real, deliberate
// differences from that prototype, not a verbatim port:
//
//   - Interaction (tapTime/tapPos/ripple) stripped out entirely.
//     Stage 1 answers "can the material look alive at rest" — Stage 3
//     answers "can it be disturbed." Mixing both loses the
//     diagnostic clarity the staged plan exists to protect. The
//     prototype's own tapRipple() was, tellingly, fully written and
//     never actually called — a second, separate ripple calculation
//     was duplicated inline instead. Neither survived this port.
//   - The background particle layer is gone. This shader draws only
//     the orb itself, fully transparent everywhere else, over the
//     app's own existing void/spark background — not a standalone
//     scene the way the HTML prototype was.
//   - Palette kept at the app's own already-established warm
//     red/orange (the same values this file's first revision used),
//     not the prototype's own numbers. This app's actual brand is
//     ember/coal warmth on purpose — "too hot" isn't necessarily the
//     right note for this specific project.
//
// Still, deliberately, state-blind: only uSize and uTime reach this
// file, same as revision A. The real, open, honest question this
// revision exists to answer: does an 80-step raymarch with real
// SDF-normal lighting actually perform on the real device, confined
// to the orb's real ~96x96 size — not inferred from a desktop browser
// running the same shader full-screen, which is a materially
// different, much larger workload.

uniform vec2 uSize;
uniform float uTime;

out vec4 fragColor;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

// Real, standard 3D simplex noise (Ashima Arts / Ian McEwan
// formulation) — the same well-established algorithm the prototype
// used, ported directly rather than reinvented or approximated.
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// One broad, coherent peak across the orb — not many small ripples.
// Three octaves, deliberately weighted so the first dominates.
float coherentSwell(vec3 p, float t) {
  float w1 = snoise(p * 0.35 + vec3(t * 0.08, t * 0.06, t * 0.04));
  float w2 = snoise(p * 0.18 + vec3(t * 0.03 + 100.0, t * 0.025, t * 0.02));
  float w3 = snoise(p * 0.55 + vec3(t * 0.12, -t * 0.09, t * 0.07)) * 0.3;
  return w1 * 0.55 + w2 * 0.35 + w3 * 0.10;
}

// Low-octave fBM for gentle organic surface texture, subtle on purpose.
float fbm(vec3 p, float t) {
  float val = 0.0;
  float amp = 0.5;
  float freq = 0.4;
  vec3 shift = vec3(t * 0.02, t * 0.015, t * 0.01);
  for (int i = 0; i < 3; i++) {
    val += amp * snoise(p * freq + shift);
    freq *= 2.1;
    amp *= 0.45;
    shift += vec3(1.7, 3.1, 5.3);
  }
  return val;
}

// The deformed sphere itself — swell, subtle fBM texture, and a slow
// breathing settle at rest. No interaction here on purpose; that's
// Stage 3's question, not this one.
float sphereDeformed(vec3 p, float t) {
  float baseRadius = 0.38;
  float swell = coherentSwell(p, t) * 0.035;
  float deform = fbm(p, t) * 0.018;
  float breath = sin(t * 0.4) * 0.008 + sin(t * 0.17) * 0.005;
  return length(p) - (baseRadius + swell + deform + breath);
}

vec3 calcNormal(vec3 p, float t) {
  vec2 e = vec2(0.0008, 0.0);
  return normalize(vec3(
    sphereDeformed(p + e.xyy, t) - sphereDeformed(p - e.xyy, t),
    sphereDeformed(p + e.yxy, t) - sphereDeformed(p - e.yxy, t),
    sphereDeformed(p + e.yyx, t) - sphereDeformed(p - e.yyx, t)
  ));
}

void main() {
  vec2 res = uSize;
  vec2 uv = (FlutterFragCoord().xy - res * 0.5) / min(res.x, res.y);
  float t = uTime;

  vec3 ro = vec3(0.0, 0.0, 1.2);
  vec3 rd = normalize(vec3(uv, -1.0));

  float d = 0.0;
  vec3 p = ro;
  float hit = 0.0;
  for (int i = 0; i < 80; i++) {
    p = ro + rd * d;
    float sd = sphereDeformed(p, t);
    if (abs(sd) < 0.0005) { hit = 1.0; break; }
    if (d > 3.0) break;
    d += sd * 0.6;
  }

  if (hit < 0.5) {
    // Nothing here — transparent, so the app's own void/spark
    // background shows through, exactly like the old Container orb.
    fragColor = vec4(0.0);
    return;
  }

  vec3 n = calcNormal(p, t);
  vec3 viewDir = normalize(-rd);

  vec3 lightDir = normalize(vec3(0.6, 0.8, 0.4));
  vec3 lightDir2 = normalize(vec3(-0.4, -0.3, 0.6));

  float diff = max(dot(n, lightDir), 0.0);
  float diff2 = max(dot(n, lightDir2), 0.0) * 0.3;

  float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
  float internal = coherentSwell(p * 1.5, t * 0.5) * 0.5 + 0.5;

  // The app's own already-established warm palette — the same values
  // this file's first revision used, not new numbers.
  vec3 deepColor = vec3(0.35, 0.04, 0.05);
  vec3 baseColor = vec3(0.90, 0.22, 0.16);
  vec3 rimColor = vec3(1.0, 0.55, 0.30);

  vec3 col = mix(deepColor, baseColor, internal * 0.6 + 0.2);
  col += vec3(1.0, 0.6, 0.3) * diff * 0.15;
  col += vec3(0.3, 0.2, 0.4) * diff2 * 0.08;

  vec3 halfDir = normalize(lightDir + viewDir);
  float spec = pow(max(dot(n, halfDir), 0.0), 64.0);
  col += vec3(1.0, 0.9, 0.7) * spec * 0.4;

  float rim = fresnel * (0.6 + 0.4 * snoise(p * 2.0 + t * 0.05));
  col += rimColor * rim * 0.8;

  float shell = pow(internal, 2.0) * 0.35;
  col += baseColor * shell;

  col = col / (col + vec3(0.8)) * 1.2;

  // Premultiplied alpha, as Flutter's fragment shader output requires
  // — fully opaque here, so no premultiplication subtlety to get wrong.
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
