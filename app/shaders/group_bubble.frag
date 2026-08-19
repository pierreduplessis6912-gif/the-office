#include <flutter/runtime_effect.glsl>

precision highp float;
uniform vec2 uSize;
uniform float uTime;
out vec4 fragColor;

float hash(float n) { return fract(sin(n) * 43758.5453123); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i.x + i.y * 57.0);
  float b = hash(i.x + 1.0 + i.y * 57.0);
  float c = hash(i.x + (i.y + 1.0) * 57.0);
  float d = hash(i.x + 1.0 + (i.y + 1.0) * 57.0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec2 uv = (FlutterFragCoord().xy - uSize * 0.5) / min(uSize.x, uSize.y);
  float t = uTime;
  float r = length(uv);
  float radius = 0.46;

  float sphereMask = 1.0 - smoothstep(radius - 0.015, radius + 0.005, r);
  if (sphereMask <= 0.0) { fragColor = vec4(0.0); return; }

  float z = sqrt(max(0.0, radius * radius - dot(uv, uv)));

  // Deliberately just the container material - no slit, no internal
  // focal point. This is the group, not a person; the embers placed
  // inside it (real Flutter widgets, not part of this shader) are
  // the actual focal points.
  float baseAlpha = 0.05;
  float fresnel = pow(1.0 - z, 1.6);
  float rimAlpha = fresnel * 0.85;

  // A faint, slow internal drift - just enough that the glass reads
  // as alive, not enough to compete with what floats inside it.
  float drift = noise(uv * 2.5 + t * 0.03) * 0.5 + noise(uv * 4.0 - t * 0.02) * 0.25;
  float internalGlow = drift * 0.04;

  vec3 col = vec3(0.65, 0.7, 0.8);
  float alpha = (baseAlpha + rimAlpha + internalGlow) * sphereMask;

  fragColor = vec4(col * alpha, alpha);
}
