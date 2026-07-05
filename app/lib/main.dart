import 'package:flutter/material.dart';

/// The one thing every future client (Flutter, PWA, desktop) points at.
/// Deliberately not baked in anywhere else in this file — changing this
/// one line (or, later, passing it via --dart-define at build time) is
/// the entire cost of a domain swap. No app-store re-release required
/// just because a backend address changed.
const officeApiBase = 'https://office.websitehub.co.za';

void main() => runApp(const OfficeApp());

class OfficeApp extends StatelessWidget {
  const OfficeApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'The Office',
      theme: ThemeData(
        colorSchemeSeed: const Color(0xFF2D6A4F),
        useMaterial3: true,
      ),
      home: const OfficeHome(),
    );
  }
}

class OfficeHome extends StatelessWidget {
  const OfficeHome({super.key});

  // Placeholder data — this milestone proves the pipeline (write code,
  // push, cloud build, install), nothing more. Real audio capture, real
  // transcripts, and a real backend call are the next milestone, not
  // this one.
  static const _recent = [
    'Morning Peter... you have a job at 09:00 in Eshowe.',
    'Jenny Hawkins invoice — 20% still outstanding.',
    'Reminder set: boys finish soccer at 14:00 on Wednesday.',
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Office')),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Row(
                    children: [
                      IconButton(
                        iconSize: 36,
                        icon: const Icon(Icons.mic),
                        onPressed: () {
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(content: Text('Speak — coming next')),
                          );
                        },
                      ),
                      const SizedBox(width: 12),
                      const Expanded(child: Text('Morning Peter...')),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 24),
              const Text(
                'Recent conversations',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
              ),
              const SizedBox(height: 8),
              Expanded(
                child: ListView.separated(
                  itemCount: _recent.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (context, i) => ListTile(
                    leading: const Icon(Icons.chat_bubble_outline),
                    title: Text(_recent[i]),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
