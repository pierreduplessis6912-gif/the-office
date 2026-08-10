// raymarched_orb.frag
// A/B experiment, worth trying per direct instruction despite the
// real performance cost named clearly beforehand - a genuine 80-step
// raymarch, an order of magnitude heavier than living_orb.frag's
// cheap projected-sphere approach. Converted to Flutter's actual,
// proven shader conventions (#include <flutter/runtime_effect.glsl>,
// FlutterFragCoord()) rather than the original's #version 300 es /
// gl_FragCoord style, which hasn't been confirmed to compile under
// Impeller - both other shaders in this project use the convention
// below and both have actually compiled successfully.

#include <flutter/runtime_effect.glsl>

precision highp float;

uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uMouse;
uniform float uTapTime;

out vec4 fragColor;

// ── Simplex 3D Noise (Ashima / Ian McEwan) ──
vec3 mod289(vec3 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
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
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

// ── Coherent swell: one broad peak, low spatial freq ──
float coherentSwell(vec3 p, float t) {
  float w1 = snoise(p * 0.35 + vec3(t * 0.08, t * 0.06, t * 0.04));
  float w2 = snoise(p * 0.18 + vec3(t * 0.03 + 100.0, t * 0.025, t * 0.02));
  float w3 = snoise(p * 0.55 + vec3(t * 0.12, -t * 0.09, t * 0.07)) * 0.3;
  return w1 * 0.55 + w2 * 0.35 + w3 * 0.10;
}

// ── Low-octave fBM for surface deformation ──
float fbm(vec3 p, float t) {
  float val = 0.0, amp = 0.5, freq = 0.4;
  vec3 shift = vec3(t * 0.02, t * 0.015, t * 0.01);
  for (int i = 0; i < 3; i++) {
    val += amp * snoise(p * freq + shift);
    freq *= 2.1;
    amp *= 0.45;
    shift += vec3(1.7, 3.1, 5.3);
  }
  return val;
}

// ── Deformed sphere SDF ──
float sphereDeformed(vec3 p, float t, float tapTime, vec3 tapPos) {
  float base = 0.38;
  float swell  = coherentSwell(p, t) * 0.035;
  float deform = fbm(p, t) * 0.018;
  float breath = sin(t * 0.4) * 0.008 + sin(t * 0.17) * 0.005;
  float ripple = 0.0;
  if (tapTime > 0.0) {
    float dt = t - tapTime;
    float d  = length(p - tapPos);
    ripple = sin(d * 15.0 - dt * 6.0)
           * exp(-dt * 1.5)
           * exp(-d * 2.0)
           * 0.04
           * smoothstep(0.0, 0.5, dt);
  }
  return length(p) - (base + swell + deform + breath + ripple);
}

vec3 calcNormal(vec3 p, float t, float tapTime, vec3 tapPos) {
  vec2 e = vec2(0.0008, 0.0);
  return normalize(vec3(
    sphereDeformed(p+e.xyy,t,tapTime,tapPos) - sphereDeformed(p-e.xyy,t,tapTime,tapPos),
    sphereDeformed(p+e.yxy,t,tapTime,tapPos) - sphereDeformed(p-e.yxy,t,tapTime,tapPos),
    sphereDeformed(p+e.yyx,t,tapTime,tapPos) - sphereDeformed(p-e.yyx,t,tapTime,tapPos)
  ));
}

// ── Background particles (warm red motes) ──
vec3 particles(vec2 uv, float t, float seed) {
  vec3 col = vec3(0.0);
  for (float i = 0.0; i < 35.0; i++) {
    float fi = i + seed * 100.0;
    vec2 pos = vec2(
      fract(sin(fi * 12.9898 + seed) * 43758.5453),
      fract(sin(fi * 78.233  + seed) * 43758.5453)
    );
    pos.x += sin(t * 0.15 + fi) * 0.08;
    pos.y += cos(t * 0.12 + fi * 1.3) * 0.06;
    float size = 0.003 + fract(sin(fi * 43.12) * 100.0) * 0.006;
    float d = length(uv - pos);
    float alpha = smoothstep(size, 0.0, d)
                * (0.3 + 0.7 * fract(sin(fi * 91.2) * 100.0));
    vec3 pc = mix(vec3(0.9,0.25,0.15), vec3(0.95,0.45,0.2),
                  fract(sin(fi * 33.7) * 100.0));
    col += pc * alpha * 0.6;
  }
  return col;
}

void main() {
  vec2 fragCoord = FlutterFragCoord().xy;
  vec2 uv = (fragCoord - uResolution * 0.5) / min(uResolution.x, uResolution.y);
  vec2 mouse = (uMouse - uResolution * 0.5) / min(uResolution.x, uResolution.y);
  float t = uTime;
  float tapTime = uTapTime;

  vec3 ro = vec3(0.0, 0.0, 1.2);
  vec3 rd = normalize(vec3(uv, -1.0));
  vec3 tapPos = vec3(mouse * 0.5, 0.25);

  // Raymarch
  float d = 0.0, hit = 0.0;
  vec3 p = ro;
  for (int i = 0; i < 80; i++) {
    p = ro + rd * d;
    float sd = sphereDeformed(p, t, tapTime, tapPos);
    if (abs(sd) < 0.0005) { hit = 1.0; break; }
    if (d > 3.0) break;
    d += sd * 0.6;
  }

  vec3 bg = vec3(0.04, 0.03, 0.03);
  bg += particles(fragCoord / uResolution, t, 0.0);
  bg += particles(fragCoord / uResolution + 0.5, t * 0.7, 1.0);

  if (hit < 0.5) {
    // Real bug fix, found live: this was hardcoded to fully opaque
    // alpha (1.0), which painted the shader's entire canvas rectangle
    // as a visible, dark-gray square - bg isn't pure black, and an
    // opaque fill of it is exactly the box that showed up against the
    // app's true-black void. Both other shaders in this project
    // already handle this correctly (fully transparent alpha /
    // masked to zero outside their own visible shape) - this one just
    // never got the same treatment.
    fragColor = vec4(bg * (1.0 - dot(uv,uv)*0.4), 0.0);
    return;
  }

  vec3 n = calcNormal(p, t, tapTime, tapPos);
  vec3 viewDir = normalize(-rd);

  // Lighting
  vec3 lightDir  = normalize(vec3(0.6, 0.8, 0.4));
  vec3 lightDir2 = normalize(vec3(-0.4, -0.3, 0.6));

  float diff  = max(dot(n, lightDir),  0.0);
  float diff2 = max(dot(n, lightDir2), 0.0) * 0.3;
  float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
  float internal = coherentSwell(p * 1.5, t * 0.5) * 0.5 + 0.5;

  vec3 baseColor = vec3(0.85, 0.22, 0.08);
  vec3 deepColor = vec3(0.50, 0.05, 0.02);
  vec3 rimColor  = vec3(1.00, 0.45, 0.15);
  vec3 coolRim   = vec3(0.90, 0.30, 0.50) * 0.15;

  vec3 col = mix(deepColor, baseColor, internal * 0.6 + 0.2);
  col += vec3(1.0, 0.6, 0.3) * diff  * 0.15;
  col += vec3(0.3, 0.2, 0.4) * diff2 * 0.08;

  vec3 halfDir = normalize(lightDir + viewDir);
  float spec = pow(max(dot(n, halfDir), 0.0), 64.0);
  col += vec3(1.0, 0.9, 0.7) * spec * 0.4;

  float rim = fresnel * (0.6 + 0.4 * snoise(p * 2.0 + t * 0.05));
  col += rimColor * rim * 0.8;
  col += coolRim * fresnel * 0.3;

  float shell = pow(internal, 2.0) * 0.35;
  col += baseColor * shell;

  // Subtle refraction of background
  vec3 refractDir = refract(rd, n, 0.85);
  vec2 refractUV = uv + refractDir.xy * 0.015;
  vec3 bgRefracted = bg + particles(refractUV * 0.5 + 0.5, t, 2.0);
  col = mix(col, bgRefracted, fresnel * 0.08);

  col = col / (col + vec3(0.8)) * 1.2;
  float orbVig = 1.0 - smoothstep(0.35, 0.55, length(uv));
  col *= 0.85 + orbVig * 0.15;

  fragColor = vec4(col, 1.0);
}
