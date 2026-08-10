// living_orb.frag
// Optimized for real animation performance, not just visual fidelity
// to a static reference. Combines the deformation philosophy from the
// old WebGL simplex-noise sphere gist with the material/normal/Fresnel
// approach proposed alongside it - but with the secondary displacement
// noise layer removed. That layer's own original comment described it
// as only "preventing mathematical perfection" (0.010 weight against
// the primary layer's 0.030) - a minor refinement, not a core
// contributor. Removing it cuts snoise() evaluations from 15 to 8 per
// pixel per frame, since surfaceNormal()'s finite-difference gradient
// calls surfaceDisplacement() six times on its own.

#include <flutter/runtime_effect.glsl>

precision highp float;

uniform vec2 uSize;
uniform float uTime;
uniform float uEnergy;

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
// SURFACE DISPLACEMENT
//
// Real, deliberate cut: the original's "secondary" noise layer
// removed. Its own comment: "secondary movement only prevents
// mathematical perfection" - a minor refinement (0.010 weight vs.
// 0.030 primary), not a core visual contributor. This function is
// called 7 times per pixel per frame (once directly, six times inside
// surfaceNormal()'s finite difference) - removing one snoise() call
// here removes 7 calls total per pixel, the single biggest real
// optimization available without changing the visual approach itself.
// ------------------------------------------------------------

float surfaceDisplacement(vec3 p, float t) {
  vec3 slowDrift = vec3(t * 0.035, t * 0.022, t * 0.015);
  float broad = snoise(p * 0.55 + slowDrift);
  return broad * 0.030;
}

// ------------------------------------------------------------
// DEFORMED SPHERE
// ------------------------------------------------------------

float sphere(vec3 p, float t) {
  float radius = 0.38;
  float swell = surfaceDisplacement(p, t);
  float breathing = sin(t * 0.35) * 0.004;
  return length(p) - (radius + swell + breathing);
}

// ------------------------------------------------------------
// NORMAL
// ------------------------------------------------------------

vec3 surfaceNormal(vec3 p, float t) {
  float e = 0.002;
  vec3 n = vec3(
    sphere(p + vec3(e, 0, 0), t) - sphere(p - vec3(e, 0, 0), t),
    sphere(p + vec3(0, e, 0), t) - sphere(p - vec3(0, e, 0), t),
    sphere(p + vec3(0, 0, e), t) - sphere(p - vec3(0, 0, e), t)
  );
  return normalize(n);
}

// ------------------------------------------------------------
// MAIN
// ------------------------------------------------------------

void main() {
  vec2 uv = FlutterFragCoord().xy;
  vec2 p = (uv - uSize * 0.5) / min(uSize.x, uSize.y);

  float t = uTime;

  float r = length(p);
  float sphereMask = 1.0 - smoothstep(0.375, 0.385, r);

  if (sphereMask <= 0.0) {
    fragColor = vec4(0.0);
    return;
  }

  float z = sqrt(max(0.0, 0.38 * 0.38 - dot(p, p)));
  vec3 surface = normalize(vec3(p.x, p.y, z));

  float displacement = surfaceDisplacement(surface, t);

  float displacedRadius = 0.38 + displacement;
  float edge = smoothstep(0.0, 0.02, displacedRadius - r);

  vec3 normal = surfaceNormal(surface, t);

  vec3 light = normalize(vec3(-0.45, 0.65, 0.75));
  float diffuse = max(dot(normal, light), 0.0);

  vec3 view = vec3(0.0, 0.0, 1.0);
  float fresnel = pow(1.0 - max(dot(normal, view), 0.0), 3.0);

  float internal = snoise(surface * 0.75 + vec3(t * 0.025, t * 0.018, t * 0.012));
  internal = internal * 0.5 + 0.5;

  vec3 deep = vec3(0.22, 0.018, 0.008);
  vec3 body = vec3(0.72, 0.095, 0.025);
  vec3 lightBody = vec3(1.0, 0.30, 0.07);

  vec3 material = mix(deep, body, internal * 0.55);
  material += lightBody * internal * 0.10;
  material += lightBody * diffuse * 0.10;
  material += vec3(1.0, 0.28, 0.08) * fresnel * 0.55;
  material += lightBody * uEnergy * 0.08;

  material *= edge;
  material *= sphereMask;

  fragColor = vec4(material, sphereMask);
}
