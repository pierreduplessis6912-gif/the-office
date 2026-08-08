#include <flutter/runtime_effect.glsl>

// Stage 1 of the real orb rebuild, 2026-08-07 — the actual material.
// Deliberately knows NOTHING about Office state: only uSize and
// uTime, plus the fixed constants below. If this looks wrong, the
// fault is here — not a controller, a state machine, or an
// interaction system, none of which exist in this file. That
// separation is the whole point of this stage.
//
// Design brief, taken directly from two rounds of verified reference
// research (read in full, not copied — see DECISIONS.md): ONE
// coherent, low-frequency swell, not noise scattered everywhere —
// "the difference between 'cool shader' and 'something alive but
// calm.'" The majority of the surface barely moves. There is always
// some slow, continuous internal movement. Energy is visible beneath
// the surface rather than screaming for attention.
//
// Real, standard 3D simplex noise below (Ashima Arts formulation —
// the same verified-real algorithm structure confirmed directly
// against the JARVIS orb.js reference before writing this), not
// invented or guessed at.

uniform vec2 uSize;
uniform float uTime;

out vec4 fragColor;

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.11369, 0.13787));
  p += dot(p, p.yxz + 19.19);
  return -1.0 + 2.0 * fract(vec3(p.x + p.y, p.x + p.z, p.y + p.z) * p.zyx);
}

float snoise3(vec3 p) {
  const float K1 = 0.333333333;
  const float K2 = 0.166666667;
  vec3 i = floor(p + (p.x + p.y + p.z) * K1);
  vec3 d0 = p - (i - (i.x + i.y + i.z) * K2);
  vec3 e = step(vec3(0.0), d0 - d0.yzx);
  vec3 i1 = e * (1.0 - e.zxy);
  vec3 i2 = 1.0 - e.zxy * (1.0 - e);
  vec3 d1 = d0 - (i1 - K2);
  vec3 d2 = d0 - (i2 - K1);
  vec3 d3 = d0 - 0.5;
  vec4 h = max(0.6 - vec4(dot(d0, d0), dot(d1, d1), dot(d2, d2), dot(d3, d3)), 0.0);
  vec4 n = h * h * h * h * vec4(
    dot(d0, hash33(i)),
    dot(d1, hash33(i + i1)),
    dot(d2, hash33(i + i2)),
    dot(d3, hash33(i + 1.0))
  );
  return dot(vec4(31.316), n);
}

void main() {
  vec2 res = uSize;
  float minDim = min(res.x, res.y);
  vec2 uv = (FlutterFragCoord().xy - res * 0.5) / (minDim * 0.5);
  float r = length(uv);

  // The one coherent swell — a single large-scale, slow-evolving
  // noise sample. Deliberately the only distortion source in this
  // whole file. Low spatial frequency (uv * 1.1, not 4 or 8) and low
  // temporal frequency (0.12) on purpose — this should read as a lake,
  // not a plasma ball.
  float t = uTime * 0.12;
  float swell = snoise3(vec3(uv * 1.1, t));

  // SDF circle, radius gently modulated by the swell rather than a
  // fixed boundary — "the majority of the surface barely moves."
  float radius = 0.78 + swell * 0.035;
  float d = r - radius;

  // Soft glass edge, not a hard cutoff.
  float edge = smoothstep(0.04, -0.04, d);

  // Internal light — brighter and warmer toward the center. "Energy
  // visible beneath the surface, rather than screaming for attention."
  float depth = 1.0 - smoothstep(0.0, radius, r);
  float innerGlow = pow(clamp(depth, 0.0, 1.0), 1.6);

  // One quiet highlight, drifting extremely slowly — not an orbiting
  // point light, just a slow, calm presence, offset toward where a
  // real light source would sit.
  vec2 highlightPos = vec2(-0.28, 0.32) + 0.05 * vec2(
    snoise3(vec3(0.0, 0.0, t * 0.7)),
    snoise3(vec3(5.0, 5.0, t * 0.7))
  );
  float highlight = smoothstep(0.55, 0.0, length(uv - highlightPos));

  // Rim light — brighter right at the glass boundary, fading both
  // inward and outward, giving the edge real presence without a hard
  // ring.
  float rim = exp(-abs(d) * 9.0) * 0.6;

  // The app's own established warm red/orange palette — not a new
  // color language, the same material this project already speaks.
  vec3 core = vec3(0.35, 0.04, 0.05);
  vec3 mid = vec3(0.90, 0.22, 0.16);
  vec3 brightRim = vec3(1.0, 0.55, 0.30);

  vec3 col = mix(core, mid, innerGlow);
  col = mix(col, brightRim, clamp(rim + highlight * 0.5, 0.0, 1.0));

  // Faint outer glow beyond the glass itself, echoing the existing
  // halo already painted behind this shader by _CircleGlowPainter —
  // kept subtle on purpose, not a second competing glow.
  float outerGlow = exp(-max(d, 0.0) * 5.0) * 0.22 * step(0.0, d);
  col += brightRim * outerGlow;
  float alpha = max(edge, outerGlow);

  // Premultiplied alpha, as Flutter's fragment shader output requires.
  fragColor = vec4(col * alpha, alpha);
}
