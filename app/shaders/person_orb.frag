#include <flutter/runtime_effect.glsl>

precision highp float;
uniform vec2 uSize;
uniform float uTime;
uniform vec3 uColor;
uniform float uSeed;
out vec4 fragColor;

float hash(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
  vec2 uv = (FlutterFragCoord().xy - uSize * 0.5) / min(uSize.x, uSize.y);
  float t = uTime + uSeed * 17.0;
  float r = length(uv);
  float radius = 0.42;

  float sphereMask = 1.0 - smoothstep(radius - 0.01, radius + 0.005, r);
  if (sphereMask <= 0.0) { fragColor = vec4(0.0); return; }

  float z = sqrt(max(0.0, radius * radius - dot(uv, uv)));
  vec3 p = vec3(uv, z) / radius;

  // Translucent, glass-like base - low, honest opacity rather than
  // an opaque, emissive material. Real, direct feedback: "translucent
  // orbs" - the opposite design goal from the main orb's solid,
  // fiery material.
  float baseAlpha = 0.22;

  // Fresnel rim - bright at the edge, near-transparent toward the
  // center. This is the real, core technique for a glass look (the
  // same Fresnel term already proven on the main orb, but here it
  // IS the material, not just an accent on top of an opaque one).
  float fresnel = pow(1.0 - z, 2.2);
  float rimAlpha = fresnel * 0.65;

  // The slit ember - a narrow, vertical, tapered bright band at the
  // center, not a flowing ribbon. Tapered top/bottom like a real
  // pupil, not a full-height line. A slow, irregular flicker (not a
  // smooth sine) matches the app's own, established crackle language
  // for "alive," rather than introducing a new motion vocabulary.
  float slitWidth = 0.045;
  float slitTaper = smoothstep(0.95, 0.15, abs(uv.y) / radius);
  float slitDist = abs(uv.x) / slitWidth;
  float slit = (1.0 - smoothstep(0.0, 1.0, slitDist)) * slitTaper;

  float flickerPhase = floor(t * 3.0);
  float flicker = mix(hash(flickerPhase + uSeed), hash(flickerPhase + 1.0 + uSeed), smoothstep(0.0, 1.0, fract(t * 3.0)));
  float slitBrightness = 0.6 + flicker * 0.4;

  vec3 col = uColor;
  float alpha = baseAlpha * sphereMask + rimAlpha * sphereMask;
  vec3 finalCol = col * (baseAlpha + rimAlpha * 1.4);
  finalCol += col * slit * slitBrightness * 1.8;
  alpha += slit * slitBrightness * 0.7;

  fragColor = vec4(finalCol, clamp(alpha, 0.0, 1.0) * sphereMask);
}
