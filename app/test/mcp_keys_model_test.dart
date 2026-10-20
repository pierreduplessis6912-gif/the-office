// Front-end slice 10 (lib/mcp_keys_model.dart): the owner's keys for outside assistants. What this pins: the list and the freshly issued key are read exactly as the backend sends them (the key only when it is in the key format and its id matches, and only when the backend says it is shown once); anything unusable is null or skipped and nothing throws; the lines the screen shows say the right thing; and a typed label is tidied the way the backend will accept it.
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/mcp_keys_model.dart';

const _secret = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-aBcDe';
const _id = '0123456789abcdef';

Map<String, Object?> _key({Object? id = _id, Object? label = 'Claude on my phone', Object? lastUsed, Object? revoked, Object? uses = 0}) =>
    {'id': id, 'label': label, 'email': 'owner@example.com', 'created_at': '2026-10-20 11:24:13', 'created_by': 'owner@example.com', 'last_used_at': lastUsed, 'revoked_at': revoked, 'uses': uses};

void main() {
  test('the list is read: id, label, member, dates, uses, and whether it is still active', () {
    final keys = parseKeyList({'keys': [_key(lastUsed: '2026-10-21 08:00:00', uses: 14), _key(id: 'fedcba9876543210', label: 'Cursor', revoked: '2026-10-22 09:00:00')]})!;
    expect(keys.map((k) => k.label), ['Claude on my phone', 'Cursor']);
    expect(keys.map((k) => k.active), [true, false]);
    expect(keys.first.uses, 14);
    expect(keys.first.email, 'owner@example.com');
    expect(keys.first.createdAt, '2026-10-20 11:24:13');
  });

  test('an empty list is an empty list; anything that is not a list answer is null; hostile entries are skipped and nothing throws', () {
    expect(parseKeyList({'keys': []}), isEmpty);
    for (final b in <Object?>[null, 'x', 5, <Object?>[], <String, Object?>{}, {'keys': 'no'}, {'keys': {'a': 1}}]) {
      expect(parseKeyList(b), isNull, reason: '$b');
    }
    final skipped = parseKeyList({'keys': [null, 5, 'x', {'id': 'short', 'label': 'x'}, {'id': _id}, {'id': _id.toUpperCase(), 'label': 'x'}, {'id': 7, 'label': 'x'}, _key(label: 5), _key(uses: -3), _key(uses: 'many')]})!;
    expect(skipped, hasLength(2));
    expect(skipped.every((k) => k.uses == 0), isTrue);
  });

  test('the list is bounded: at most 50 keys, and long text is cut', () {
    final many = [for (var i = 0; i < 80; i++) _key(id: i.toRadixString(16).padLeft(16, '0'))];
    expect(parseKeyList({'keys': many}), hasLength(50));
    expect(parseKeyList({'keys': [_key(label: 'x' * 900)]})!.single.label.length, 200);
  });

  test('a freshly issued key is read only when it is in the key format, its id matches, and the backend says it is shown once', () {
    final good = {'id': _id, 'key': 'omk.acme-co.$_id.$_secret', 'label': 'Claude on my phone', 'email': 'owner@example.com', 'shownOnce': true, 'note': 'Copy this key now.'};
    final k = parseIssued(good)!;
    expect(k.key, 'omk.acme-co.$_id.$_secret');
    expect(k.id, _id);
    expect(k.label, 'Claude on my phone');
    final bad = <Object?>[
      null, 'x', 5, <Object?>[], <String, Object?>{},
      {...good, 'shownOnce': false}, {...good, 'shownOnce': null}, {...good, 'id': 'short'}, {...good, 'id': 'fedcba9876543210'},
      {...good, 'key': 'xmk.acme-co.$_id.$_secret'}, {...good, 'key': 'omk.acme-co.$_id'}, {...good, 'key': 'omk.acme-co.$_id.short'}, {...good, 'key': 'omk.acme-co.$_id.$_secret.extra'}, {...good, 'key': 5}, {...good, 'key': 'omk.acme-co.$_id.${'A' * 300}'}, {...good, 'label': null},
    ];
    for (final b in bad) {
      expect(parseIssued(b), isNull, reason: '$b');
    }
  });

  test('the address to give an assistant is the API base plus /mcp, whatever slashes the base ends with', () {
    expect(mcpAddress('https://office.websitehub.co.za'), 'https://office.websitehub.co.za/mcp');
    expect(mcpAddress('https://office.websitehub.co.za/'), 'https://office.websitehub.co.za/mcp');
    expect(mcpAddress('https://office.websitehub.co.za///'), 'https://office.websitehub.co.za/mcp');
  });

  test('the lines on a key say when it was made and used, in plain words', () {
    expect(useLine(McpKey(id: _id, label: 'x', email: '')), 'Never used');
    expect(useLine(const McpKey(id: _id, label: 'x', email: '', lastUsedAt: 'not a time', uses: 3)), 'Never used');
    final one = useLine(const McpKey(id: _id, label: 'x', email: '', lastUsedAt: '2026-10-21 08:00:00', uses: 1));
    final many = useLine(const McpKey(id: _id, label: 'x', email: '', lastUsedAt: '2026-10-21 08:00:00', uses: 14));
    expect(one, startsWith('Last used '));
    expect(one, endsWith(', 1 call'));
    expect(many, endsWith(', 14 calls'));
    expect(createdLine(const McpKey(id: _id, label: 'x', email: '', createdAt: '2026-10-20 11:24:13')), startsWith('Created '));
    expect(createdLine(const McpKey(id: _id, label: 'x', email: '')), '');
  });

  test('a typed label is tidied: trimmed, control characters removed, at most 60 characters, and nothing usable is null', () {
    expect(tidyLabel('  Claude on my phone  '), 'Claude on my phone');
    expect(tidyLabel('a\nb\tc'), 'a b c');
    expect(tidyLabel('x' * 100)!.length, 60);
    for (final s in ['', '   ', '\n\t']) {
      expect(tidyLabel(s), isNull, reason: shown(s));
    }
  });
}

String shown(String s) => s.replaceAll('\n', r'\n').replaceAll('\t', r'\t');
