#include <flutter/runtime_effect.glsl>

// Stage 0 of the real orb rebuild, 2026-08-07 — proves the pipeline,
// not the math: asset declared in pubspec.yaml -> compiled by
// impellerc -> loaded via FragmentProgram.fromAsset -> rendered on
// the real device -> uSize and uTime both update correctly every
// frame from Dart. Deliberately trivial on purpose — no SDF, no
// noise, no helper functions beyond what's necessary — so a failure
// here means Flutter/Impeller integration, not shader logic. Stage 1
// (the real material) hasn't started; this file should stay exactly
// this small until Stage 0 is confirmed on the real device.
//
// uv.y drives a simple vertical gradient (proves uSize and
// FlutterFragCoord() — not gl_FragCoord, which Impeller doesn't
// support — are wired correctly). pulse drives a slow brightness
// oscillation (proves uTime updates every frame, not just once at
// load). Fully opaque throughout, so there's no premultiplied-alpha
// subtlety to get wrong in this first pass.

uniform vec2 uSize;
uniform float uTime;

out vec4 fragColor;

void main() {
  vec2 uv = FlutterFragCoord().xy / uSize;
  float pulse = 0.5 + 0.5 * sin(uTime * 2.0);
  fragColor = vec4(pulse, uv.y * pulse, 1.0 - pulse, 1.0);
}
