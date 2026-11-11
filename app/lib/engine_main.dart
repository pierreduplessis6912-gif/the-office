// A separate entry point for the engine shell (docs/decisions/first-slice.md): run it with `flutter run -t lib/engine_main.dart` or build it with `flutter build web -t lib/engine_main.dart`. The production app's entry point, lib/main.dart, is untouched and does not use any of this.
//
// WHAT IT IS: the persistent orb, a typed question, the answer card, drill-down and the approval card, running on the engine's RECORDED answers (lib/engine/engine_fixtures.dart, generated from the engine's own routes and kept equal to the backend by
// tools/slice-mokoena.test.js). It is NOT connected to any business, staging or production, and says so on screen. WHAT IT IS NOT: a live connection. Connecting the shell to a real engine business is a separate step that needs Pierre's approval.
// The menu at the top right switches who is asking and what the business has, so every honest answer (a restricted member, a business without the capability, a member who cannot record, a stale approval, two customers with one name) can be seen.
import 'package:flutter/material.dart';

import 'engine/engine_api.dart';
import 'engine/engine_fixtures.dart';
import 'engine/assistant_panel.dart';
import 'engine/engine_shell.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const EngineDemoApp());
}

class EngineDemoApp extends StatelessWidget {
  const EngineDemoApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'The Office',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark(useMaterial3: true).copyWith(scaffoldBackgroundColor: const Color(0xFF0A0A0B)),
      home: const EngineDemoHome(),
    );
  }
}

class _Scenario {
  final String id;
  final String label;
  const _Scenario(this.id, this.label);
}

const List<_Scenario> _scenarios = <_Scenario>[
  _Scenario('accountant', 'Accountant (can read and record)'),
  _Scenario('readonly', 'Can read, cannot record'),
  _Scenario('installer', 'Installer (restricted)'),
  _Scenario('unavailable', 'Business without the capability'),
  _Scenario('ambiguous', 'Two customers called Mokoena'),
  _Scenario('stale', 'Account changes before approval'),
];

class EngineDemoHome extends StatefulWidget {
  const EngineDemoHome({super.key});

  @override
  State<EngineDemoHome> createState() => _EngineDemoHomeState();
}

class _EngineDemoHomeState extends State<EngineDemoHome> {
  final Map<String, EngineResponse> _fixtures = engineResponsesFrom(engineFixtureJson);
  String _scenario = 'accountant';
  int _tab = 0;   // 0: the first slice (what a customer owes); 1: the assistant (everything built since)
  final Map<String, FixtureEngineApi> _assistantApis = <String, FixtureEngineApi>{};

  EngineApi _api() {
    switch (_scenario) {
      case 'readonly':
        return FixtureEngineApi(_fixtures, canRecord: false);
      case 'installer':
        return FixtureEngineApi(_fixtures, role: 'installer');
      case 'unavailable':
        return FixtureEngineApi(_fixtures, capabilityAvailable: false);
      case 'ambiguous':
        return FixtureEngineApi(_fixtures, ambiguous: true);
      case 'stale':
        return FixtureEngineApi(_fixtures, staleApproval: true);
      default:
        return FixtureEngineApi(_fixtures);
    }
  }

  String _label() => _scenarios.firstWhere((s) => s.id == _scenario, orElse: () => _scenarios.first).label;

  @override
  Widget build(BuildContext context) {
    final assistantApi = _assistantApis.putIfAbsent(_scenario, () => _api() as FixtureEngineApi);
    return Scaffold(
      backgroundColor: const Color(0xFF0A0A0B),
      body: _tab == 0 ? _slice() : SafeArea(child: AssistantPanel(key: ValueKey<String>('assistant-$_scenario'), api: assistantApi, footnote: 'Recorded engine answers, not a live business. Showing: ${_label()}.')),
      bottomNavigationBar: NavigationBar(
        key: const Key('demo-tabs'),
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.account_balance_wallet_outlined), label: 'What is owed'),
          NavigationDestination(icon: Icon(Icons.chat_bubble_outline), label: 'Assistant'),
        ],
      ),
    );
  }

  Widget _slice() {
    return Stack(
      children: [
        EngineShell(
          key: ValueKey<String>(_scenario),
          api: _api(),
          footnote: 'Recorded engine answers, not a live business. Showing: ${_label()}.',
        ),
        Positioned(
          top: 4,
          right: 4,
          child: SafeArea(
            child: Material(
              type: MaterialType.transparency,
              child: PopupMenuButton<String>(
                key: const Key('demo-menu'),
                tooltip: 'Show another member or business',
                icon: const Icon(Icons.tune, color: Color(0xFF5A5A5F)),
                onSelected: (id) => setState(() {
                  _scenario = id;
                  _assistantApis.remove(id);
                }),
                itemBuilder: (context) => [
                  for (final s in _scenarios) PopupMenuItem<String>(value: s.id, child: Text(s.label)),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}
