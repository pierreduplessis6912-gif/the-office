// The line editor the quotation form (and later the invoice draft form) uses: rows of description, quantity, unit, unit price in rand and whether the line has VAT (15%). It only reads what was typed into
// the engine's own line shape ({description, quantityMilli, unit, unitPriceMinor, taxBp}); nothing is totalled here, the engine works the totals out and shows them on approval.
import 'package:flutter/material.dart';

import 'money_input.dart';

class _LineRow {
  final description = TextEditingController();
  final quantity = TextEditingController(text: '1');
  final unit = TextEditingController();
  final price = TextEditingController();
  bool vat = true;
  void dispose() {
    description.dispose();
    quantity.dispose();
    unit.dispose();
    price.dispose();
  }
}

class LineEditorController extends ChangeNotifier {
  final List<_LineRow> _rows = <_LineRow>[_LineRow()];
  int get count => _rows.length;

  void add() {
    _rows.add(_LineRow());
    notifyListeners();
  }

  void remove(int i) {
    if (_rows.length <= 1) return;
    _rows.removeAt(i).dispose();
    notifyListeners();
  }

  void toggleVat(int i, bool v) {
    _rows[i].vat = v;
    notifyListeners();
  }

  /// The lines in the engine's shape, or null with [problem] saying which line is unclear. Nothing is guessed.
  List<Map<String, Object?>>? read(void Function(String problem) problem) {
    final out = <Map<String, Object?>>[];
    for (var i = 0; i < _rows.length; i++) {
      final r = _rows[i];
      final at = 'Line ${i + 1}';
      final what = r.description.text.trim();
      if (what.isEmpty) {
        problem('$at needs a description.');
        return null;
      }
      final q = quantityToMilli(r.quantity.text);
      if (q == null) {
        problem('$at: type the quantity as a number, for example 2 or 2.5.');
        return null;
      }
      final p = randToMinor(r.price.text);
      if (p == null) {
        problem('$at: type the price in rand, for example 450.00.');
        return null;
      }
      final unit = r.unit.text.trim();
      out.add(<String, Object?>{'description': what, 'quantityMilli': q, 'unit': unit.isEmpty ? null : unit, 'unitPriceMinor': p, 'taxBp': r.vat ? 1500 : 0});
    }
    return out;
  }

  @override
  void dispose() {
    for (final r in _rows) {
      r.dispose();
    }
    super.dispose();
  }
}

class LineEditor extends StatelessWidget {
  final LineEditorController controller;
  final String keyPrefix;
  const LineEditor({super.key, required this.controller, required this.keyPrefix});

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        for (var i = 0; i < controller.count; i++) _row(i),
        TextButton.icon(key: Key('$keyPrefix-add-line'), onPressed: controller.add, icon: const Icon(Icons.add), label: const Text('Add a line')),
      ]),
    );
  }

  Widget _row(int i) {
    final r = controller._rows[i];
    return Card(
      key: Key('$keyPrefix-line-$i'),
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Column(children: [
          Row(children: [
            Expanded(child: TextField(key: Key('$keyPrefix-line-$i-description'), controller: r.description, decoration: InputDecoration(labelText: 'Line ${i + 1}: what is it'))),
            if (controller.count > 1) IconButton(key: Key('$keyPrefix-line-$i-remove'), tooltip: 'Remove this line', icon: const Icon(Icons.close), onPressed: () => controller.remove(i)),
          ]),
          Row(children: [
            Expanded(child: TextField(key: Key('$keyPrefix-line-$i-quantity'), controller: r.quantity, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Quantity'))),
            const SizedBox(width: 8),
            Expanded(child: TextField(key: Key('$keyPrefix-line-$i-unit'), controller: r.unit, decoration: const InputDecoration(labelText: 'Unit (m², each)'))),
            const SizedBox(width: 8),
            Expanded(child: TextField(key: Key('$keyPrefix-line-$i-price'), controller: r.price, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Price (rand)'))),
          ]),
          SwitchListTile(key: Key('$keyPrefix-line-$i-vat'), contentPadding: EdgeInsets.zero, dense: true, title: const Text('Add VAT (15%)'), value: r.vat, onChanged: (v) => controller.toggleVat(i, v)),
        ]),
      ),
    );
  }
}
