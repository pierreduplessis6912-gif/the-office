// heat_orb.frag
// No circle. Only heat.

#include <flutter/runtime_effect.glsl>

uniform vec2 uSize;
uniform float uTime;
uniform float uBreath;      // 0.0 - 1.0, slow sine
uniform float uHeartbeat;   // quick pulse on speech
uniform vec2 uCenter;       // normalized 0-1

out vec4 fragColor;

// Simplex noise helpers (simplified)
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }

float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                       -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v -   i + dot(i, C.xx);
    vec2 i1;
    i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                           + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy),
                            dot(x12.zw,x12.zw)), 0.0);
    m = m*m; m = m*m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
}

// Fractal Brownian Motion for organic turbulence
float fbm(vec2 p) {
    float sum = 0.0;
    float amp = 0.5;
    float freq = 1.0;
    for(int i = 0; i < 5; i++) {
        sum += amp * snoise(p * freq);
        freq *= 2.0;
        amp *= 0.5;
    }
    return sum;
}

void main() {
    vec2 uv = FlutterFragCoord().xy / uSize;
    vec2 center = uCenter;
    float aspect = uSize.x / uSize.y;
    vec2 q = uv - center;
    q.x *= aspect;

    float dist = length(q);

    // Breathing radius
    float baseRadius = 0.18 + uBreath * 0.015;
    float pulse = uHeartbeat * 0.025;
    float radius = baseRadius + pulse;

    // Turbulent heat field — no hard edge
    float noise = fbm(vec2(q.x * 3.5 + uTime * 0.08, q.y * 3.5 + uTime * 0.06));
    float noise2 = fbm(vec2(q.x * 6.0 - uTime * 0.12, q.y * 6.0 + uTime * 0.09));

    // Heat falloff — exponential, not linear. No visible boundary.
    float heat = exp(-dist / (radius * (0.9 + noise * 0.25)));
    heat = pow(heat, 1.4 + noise2 * 0.3);

    // Colour temperature: cream -> orange -> red -> deep ember
    vec3 cream = vec3(1.0, 0.85, 0.65);
    vec3 orange = vec3(1.0, 0.55, 0.26);
    vec3 red = vec3(0.91, 0.28, 0.18);
    vec3 ember = vec3(0.35, 0.04, 0.02);
    vec3 black = vec3(0.02, 0.0, 0.0);

    vec3 color;
    float t = heat;
    if(t > 0.85) {
        color = mix(orange, cream, (t - 0.85) / 0.15);
    } else if(t > 0.55) {
        color = mix(red, orange, (t - 0.55) / 0.30);
    } else if(t > 0.20) {
        color = mix(ember, red, (t - 0.20) / 0.35);
    } else {
        color = mix(black, ember, t / 0.20);
    }

    // Subtle bright core — where Peter speaks into
    float core = exp(-dist / (radius * 0.25));
    color += vec3(1.0, 0.9, 0.75) * core * 0.25 * (0.8 + noise * 0.4);

    // Bottom reflection glow
    float ground = exp(-abs(q.y - radius * 0.8) / (radius * 0.15))
                   * exp(-abs(q.x) / (radius * 0.6));
    color += vec3(0.8, 0.2, 0.05) * ground * 0.12;

    // Vignette to true black
    float vig = 1.0 - smoothstep(0.4, 1.0, dist * 1.8);
    color *= vig;

    fragColor = vec4(color, 1.0);
}
