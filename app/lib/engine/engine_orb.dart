// The persistent orb for the engine shell: the existing FilamentOrb (lib/main.dart) EXTRACTED BY COPY, as docs/decisions/first-slice.md section B says, so main.dart stays untouched until the slice passes. Same shader
// (shaders/filament_orb.frag, already a bundled asset), same uniform order. Two differences: it does not depend on main.dart's private colours or tap reactions, and if the shader cannot be loaded (a test, an unsupported device) it
// draws a quiet still orb instead of nothing, so the orb is always there. Reduced motion stops the clock, as in the original.
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import '../accessibility.dart';

class EngineOrb extends StatefulWidget {
  /// True while the Office is working on something (thinking or executing): the orb gathers energy.
  final bool active;
  final double size;
  const EngineOrb({super.key, this.active = false, this.size = 140});

  @override
  State<EngineOrb> createState() => _EngineOrbState();
}

class _EngineOrbState extends State<EngineOrb> with SingleTickerProviderStateMixin {
  ui.FragmentProgram? _program;
  late AnimationController _ticker;
  double _tapTime = -1;
  final DateTime _start = DateTime.now();

  @override
  void initState() {
    super.initState();
    _ticker = AnimationController(vsync: this, duration: const Duration(seconds: 1))..repeat();
    _loadShader();
  }

  @override
  void didUpdateWidget(covariant EngineOrb oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active && !oldWidget.active) {
      _tapTime = DateTime.now().difference(_start).inMilliseconds / 1000.0;
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (reducedMotion(context)) {
      _ticker.stop();
    } else if (!_ticker.isAnimating) {
      _ticker.repeat();
    }
  }

  Future<void> _loadShader() async {
    try {
      final program = await ui.FragmentProgram.fromAsset('shaders/filament_orb.frag');
      if (!mounted) return;
      setState(() => _program = program);
    } catch (_) {
      // No shader available: the still orb below stays.
    }
  }

  @override
  Widget build(BuildContext context) {
    final program = _program;
    final still = reducedMotion(context);
    return Semantics(
      label: 'The Office',
      child: SizedBox(
        width: widget.size,
        height: widget.size,
        child: program == null
            ? const DecoratedBox(
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: RadialGradient(colors: [Color(0xFFC4432B), Color(0xFF5A1B10), Color(0xFF0A0A0B)], stops: [0.0, 0.7, 1.0]),
                ),
              )
            : AnimatedBuilder(
                animation: _ticker,
                builder: (_, __) => CustomPaint(
                  size: Size(widget.size, widget.size),
                  painter: _EngineOrbPainter(
                    program: program,
                    energy: widget.active ? 1.0 : 0.0,
                    time: still ? 4.0 : DateTime.now().difference(_start).inMilliseconds / 1000.0,
                    tapTime: still ? -1 : _tapTime,
                  ),
                ),
              ),
      ),
    );
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }
}

class _EngineOrbPainter extends CustomPainter {
  final ui.FragmentProgram program;
  final double energy;
  final double time;
  final double tapTime;
  _EngineOrbPainter({required this.program, required this.energy, required this.time, required this.tapTime});

  @override
  void paint(Canvas canvas, Size size) {
    final shader = program.fragmentShader();
    // Uniform order must match filament_orb.frag exactly: uSize (vec2), uTime, uEnergy, uTapTime, uIgnitionTime, uReactColor (vec3).
    shader.setFloat(0, size.width);
    shader.setFloat(1, size.height);
    shader.setFloat(2, time);
    shader.setFloat(3, energy);
    shader.setFloat(4, tapTime);
    shader.setFloat(5, -1);
    shader.setFloat(6, 0xE8 / 255.0);
    shader.setFloat(7, 0x87 / 255.0);
    shader.setFloat(8, 0x1E / 255.0);
    canvas.drawRect(Offset.zero & size, Paint()..shader = shader);
  }

  @override
  bool shouldRepaint(covariant _EngineOrbPainter old) => true;
}
