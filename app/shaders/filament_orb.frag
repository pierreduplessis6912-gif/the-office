// filament_orb.frag
// A/B experiment - third architecture, per a technical brief whose
// core diagnosis independently matched real, own testing: geometric
// deformation kills roundness (confirmed - produced a clay blob), a
// broad directional light drowns internal color variation (confirmed
// - amplifying internal noise contrast alone didn't help). This
// architecture avoids both: perfect sphere geometry, no SDF
// deformation at all; all "life" lives in emissive, domain-warped
// color rather than a lit, shaded surface. No raymarching - a cheap,
// projected sphere like living_orb.frag, ~15 noise evaluations per
// pixel, directly honoring the real, earlier "optimal animation"
// priority.

#include <flutter/runtime_effect.glsl>

precision highp float;

uniform vec2 uSize;
uniform float uTime;
uniform float uEnergy;
uniform float uTapTime;

out vec4 fragColor;

// ------------------------------------------------------------
// SIMPLEX 3D NOISE
// ------------------------------------------------------------

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

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
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m *= m;

  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// ------------------------------------------------------------
// COHERENT SWELL - the same broad, low-frequency field used for the
// deep body glow (not geometry - color only).
// ------------------------------------------------------------

float coherentSwell(vec3 p, float t) {
  return snoise(p * 0.5 + vec3(t * 0.02, t * 0.015, t * 0.01));
}

void main() {
  vec2 fragCoord = FlutterFragCoord().xy;
  vec2 uv = (fragCoord - uSize * 0.5) / min(uSize.x, uSize.y);

  float t = uTime;
  float r = length(uv);
  float radius = 0.38;

  float sphereMask = 1.0 - smoothstep(radius - 0.008, radius + 0.002, r);
  if (sphereMask <= 0.0) {
    fragColor = vec4(0.0);
    return;
  }

  // Perfect sphere geometry - reconstruct the 3D surface point
  // directly, no SDF, no deformation at all.
  float z = sqrt(max(0.0, radius * radius - dot(uv, uv)));
  vec3 p = vec3(uv, z) / radius;

  // ------------------------------------------------------------
  // DOMAIN WARPING - the real, key technique. A low-frequency warp
  // field displaces the coordinates fed into a higher-frequency
  // noise evaluation, producing organic, branching, vein-like
  // structure rather than blobby fBM clouds.
  // ------------------------------------------------------------

  vec3 warp = vec3(
    snoise(p * 0.3 + t * 0.01),
    snoise(p * 0.3 + t * 0.01 + 100.0),
    snoise(p * 0.3 + t * 0.01 + 200.0)
  ) * 0.5;

  float veins = snoise(p * 2.0 + warp + t * 0.02);
  float detail = snoise(p * 4.0 + warp * 0.5 + t * 0.03) * 0.5;
  float filaments = smoothstep(-0.1, 0.5, veins + detail);

  // Real, deliberate tap-ripple: an expanding ring using angular
  // distance from a fixed tap point, driven by isRecording via
  // uTapTime from the Flutter side.
  float ripple = 0.0;
  if (uTapTime > 0.0) {
    float dt = t - uTapTime;
    vec3 tapPoint = vec3(0.0, 0.0, 1.0);
    float angDist = acos(clamp(dot(normalize(p), tapPoint), -1.0, 1.0));
    ripple = sin(angDist * 12.0 - dt * 5.0)
           * exp(-dt * 1.2)
           * exp(-angDist * 1.5)
           * smoothstep(0.0, 0.4, dt);
  }

  float bodyGlow = coherentSwell(p, t) * 0.5 + 0.5;

  // Fast micro-sparkle, only inside bright filament veins.
  float sparkle = snoise(p * 12.0 + t * 0.6);
  sparkle = pow(max(sparkle, 0.0), 4.0) * smoothstep(0.55, 0.9, filaments);

  // ------------------------------------------------------------
  // COLOR COMPOSITION - layered, in order, per the brief. No broad
  // directional light anywhere in this stack - that was the real,
  // confirmed cause of drowning internal variation.
  // ------------------------------------------------------------

  vec3 col = vec3(0.02, 0.005, 0.002);
  col += vec3(0.8, 0.1, 0.02) * bodyGlow * 0.3;
  col += vec3(0.95, 0.22, 0.05) * filaments * 0.75;
  col += vec3(1.0, 0.42, 0.08) * pow(filaments, 3.0) * 0.45;
  col += vec3(1.0, 0.6, 0.25) * sparkle * 0.4;
  col += vec3(1.0, 0.28, 0.08) * ripple * 0.5;

  // Fresnel rim - the glass-membrane edge quality, without a
  // directional light. z is already the view-facing component.
  float fresnel = pow(1.0 - z, 3.0);
  col += vec3(1.0, 0.3, 0.1) * fresnel * 1.0;

  // The ONE small, sharp directional element - a fixed specular
  // spot, small enough it never becomes a broad gradient.
  vec3 lightDir = normalize(vec3(-0.4, 0.5, 0.7));
  vec3 normal = normalize(p);
  float spec = pow(max(dot(normal, lightDir), 0.0), 48.0);
  col += vec3(1.0, 0.9, 0.7) * spec * 0.5;

  // Very restrained energy response.
  col += vec3(1.0, 0.5, 0.15) * uEnergy * 0.08;

  col = col / (col + vec3(0.7)) * 1.15;
  col *= sphereMask;

  fragColor = vec4(col, sphereMask);
}
