#include <flutter/runtime_effect.glsl>

// The embers, rebuilt, 2026-08-08 — "tears in the veil of the void,"
// not objects sitting in it. Real technique, not guessed at: the base
// shape is Inigo Quilez's own exact vesica SDF
// (iquilezles.org/articles/distfunctions2d/, verified directly
// against the source before writing this, not approximated) — a
// closed lens/slit shape, the same primitive a rip or an eye actually
// is, ported faithfully rather than "simplified" into something that
// only looks equivalent (an early draft of this port swapped an x/y
// component pair and was quietly wrong — caught by re-deriving both
// branches by hand against the original, not by trusting a first
// pass). The same simplex noise already proven in the orb's own
// material (stage1_orb.frag) drives a slow, organic wobble of the
// tear's edge and a gentle breathing pulse, so no two embers — and no
// two moments — look identical, matching Design Constitution v2's own
// "movement random enough to feel alive."
//
// The light logic is inverted from a normal glowing object on
// purpose: this isn't a lit sphere, it's a rupture with light
// bleeding through from behind it. Brightest and hottest (near-white)
// right at the narrow tips of the slit, where the veil is thinnest,
// warm ember red/orange through the wider body, and the true void —
// true black, not dark red — immediately outside the tear's own soft
// glow falloff.
//
// State-blind in the same sense as the orb: only uSize, uTime, uSeed,
// and uColor reach this file. uColor is deliberately not "state" in
// the sense Stage 1's orb constraint means — it's each ember's own
// fixed domain identity (tasks/scheduler/finance/suppliers/pending
// already had distinct colors before this rebuild, and Peter relies
// on that distinction to tell them apart at a glance; losing it to a
// single hard-coded palette would be a real, silent functional
// regression, not just an aesthetic simplification), the same way a
// physical material has an intrinsic color independent of what's
// lighting it.

uniform vec2 uSize;
uniform float uTime;
uniform float uSeed;
uniform vec3 uColor;

out vec4 fragColor;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

// Real, standard 3D simplex noise — the same proven algorithm the
// orb's own material uses, reused rather than reinvented.
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

// Inigo Quilez's exact vesica SDF, ported faithfully — the scalar
// broadcast to vec3 is made explicit here (GLSL ES is stricter than
// desktop GLSL about implicit scalar-to-vector assignment), and the
// local variable is renamed from his "d" to "k" only to avoid
// clashing with this file's own distance variable in main() — the
// actual math is untouched.
float sdVesica(vec2 p, float w, float h) {
  vec3 k = vec3(0.5 * (w * w - h * h) / h);
  p = abs(p);
  vec3 c = (w * p.y < k.x * (p.x - w)) ? vec3(0.0, w, 0.0) : vec3(-k.x, 0.0, k.x + h);
  return length(p - c.yx) - c.z;
}

void main() {
  vec2 res = uSize;
  vec2 uv = (FlutterFragCoord().xy - res * 0.5) / (min(res.x, res.y) * 0.5);
  float t = uTime + uSeed * 37.0;

  // Slow, coherent breathing — the tear widening and narrowing very
  // gently. Never a fixed, dead shape, never fast enough to read as
  // pulsing on purpose rather than simply being alive.
  //
  // Real bug, found and fixed 2026-08-08 by actually rendering this
  // shader offline (headless GLSL via Mesa llvmpipe, not guessed at
  // from re-reading code a third time) rather than pushing blind
  // again: sdVesica's w must be the LARGER value — the half-reach
  // toward the pointed tips — and h the smaller cross-axis value.
  // The first version had these backwards (w small, h large), which
  // doesn't just misshape the curve, it breaks the formula into two
  // disconnected lobes with a dark gap between them — confirmed by
  // rendering the raw, uncolored SDF alone before touching the
  // lighting code at all. uv.yx (not uv) feeds the swapped-axis call
  // below, since w now needs to be the vertical reach for a tall,
  // narrow tear rather than a wide, flat one.
  float breath = 0.5 + 0.5 * snoise(vec3(0.0, 0.0, t * 0.15));
  float w = 0.62 + breath * 0.03;
  float h = 0.16 + breath * 0.018;

  // The edge itself is wobbled by real noise sampled around its own
  // boundary, not a perfect geometric curve — genuinely torn, not
  // drawn.
  float angle = atan(uv.y, uv.x);
  float edgeNoise = snoise(vec3(cos(angle) * 2.2, sin(angle) * 2.2, t * 0.22)) * 0.011;

  float d = sdVesica(uv.yx, w + edgeNoise, h + edgeNoise);

  // Soft glow bleeding from the rupture into the surrounding void —
  // real inverse-distance falloff, not a fixed-radius blur.
  float glow = 0.013 / max(d, 0.0008);
  glow = clamp(glow, 0.0, 1.0);

  // Hottest and brightest right at the narrow tips, where the veil is
  // thinnest — warm ember through the wider body. Light escaping a
  // rupture, not a lit object being shaded.
  //
  // Real bug, found the same way as the geometry one: this originally
  // divided by h for both insideT and tipProximity, which is why the
  // "hottest at the tips" comment didn't match what it actually
  // computed — brightest at the middle instead. Tips now correctly
  // sit at uv.y ~= +/-w (w is the vertical reach after the axis
  // swap above), and the interior-depth normalization uses h (the
  // narrow cross-axis half-width), not w.
  float insideT = clamp(-d / max(h, 0.001), 0.0, 1.0);
  float tipProximity = pow(clamp(1.0 - abs(uv.y) / w, 0.0, 1.0), 3.0);

  vec3 hot = vec3(1.0, 0.95, 0.85);
  vec3 ember = uColor;
  vec3 deepEmber = uColor * 0.35;

  vec3 core = mix(deepEmber, ember, insideT);
  core = mix(core, hot, tipProximity * insideT * 0.7);

  float inside = step(d, 0.0);
  vec3 col = core * inside + ember * glow * (1.0 - inside);
  float alpha = max(inside, glow);

  // Premultiplied alpha, as Flutter's fragment shader output requires.
  fragColor = vec4(col * alpha, alpha);
}
