// The app's handling of a usage-limit refusal (app/lib/main.dart `_serverReason`). When a member or business is over its daily limit in ENFORCE mode the server answers 429 with a plain-language "error"; the app
// must show THAT, not "Something went wrong (429)". The Dart cannot be compiled here (no Dart or Flutter in this environment; the build is Codemagic), so what is pinned is the CONTRACT between the two sides and
// the wiring: the app reads the key the server sends, acts only on a 429, and is used at every place the app sends something that uses the model.
module.exports = async function runAppLimitTests({ check, path, fs, srcDir }) {
  const dart = fs.readFileSync(path.join(__dirname, '..', 'app', 'lib', 'main.dart'), 'utf8');
  const limits = fs.readFileSync(path.join(srcDir, 'limits.ts'), 'utf8');
  const helper = dart.slice(dart.indexOf('String? _serverReason(http.Response response) {'), dart.indexOf("return 'Too many requests right now. Please try again later.';"));
  check(helper.length > 150 && /if \(response\.statusCode != 429\) return null;/.test(helper) && /jsonDecode\(response\.body\)/.test(helper) && /data is Map<String, dynamic>/.test(helper) && /final error = data\['error'\];/.test(helper) && /error is String && error\.trim\(\)\.isNotEmpty\) return error\.trim\(\)/.test(helper), 'the app\'s helper acts ONLY on a 429, reads the server\'s explanation from the "error" key and uses it only when it is a non-empty string');
  check(/\} catch \(_\) \{/.test(helper) && /return 'Too many requests right now\. Please try again later\.';/.test(dart), 'and when the body is not JSON or has no explanation it still says something plain (it never shows a raw 429 for a refusal)');
  const blockBody = limits.slice(limits.indexOf('block = Response.json('), limits.indexOf('return { countable: true, member, used, plan, over, block };'));
  check(/error: over === "messages"/.test(blockBody) && /status: 429/.test(blockBody) && /capped: true/.test(blockBody) && /midnight UTC/.test(blockBody), 'the CONTRACT: the server\'s 429 carries the explanation under the "error" key (the key the app reads), says when it resets, and is marked capped');
  const uses = [...dart.matchAll(/_serverReason\(response\) \?\? '([^']+)'/g)].map((m) => m[1]);
  check(uses.length === 3 && uses.filter((u) => u.startsWith('Something went wrong')).length === 2 && uses.filter((u) => u.startsWith('Upload failed')).length === 1, 'the helper is used at every place the app sends something that uses the model: both text sends and the upload (and the old fixed wording remains the fallback for every other failure)');
  check(!/text: 'Something went wrong \(\$\{response\.statusCode\}\)\.'/.test(dart) && !/text: 'Upload failed \(\$\{response\.statusCode\}\)\.'/.test(dart), 'and no send is left that would show a bare "Something went wrong (429)"');
  check((dart.match(/\b_serverReason\b/g) || []).length === 4 && /import 'dart:convert';/.test(dart) && /import 'package:http\/http\.dart' as http;/.test(dart), 'the helper is defined once, used three times, and the imports it needs are present');
};
