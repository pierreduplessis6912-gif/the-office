// The production health alert (.github/workflows/prod-health.yml). Its judging script is EXTRACTED and RUN here against every way a business can be unhealthy, because an alert that stays quiet when something
// is wrong is worse than none. It must call each problem unhealthy with the reason, must not cry wolf on a healthy night or on a job that is merely scheduled, and must never take silence for health.
module.exports = async function runProdHealthTests({ check, path, fs }) {
  const { execFileSync } = require('child_process'), os = require('os');
  const code = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'prod-health.yml'), 'utf8').replace(/^\s*#.*$/gm, '');
  const secretsOf = (c) => [...new Set([...c.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]))].sort();
  const judgeStart = code.indexOf('name: Judge the health report');
  const script = code.slice(code.indexOf("python3 - <<'PY'", judgeStart), code.indexOf('\n          PY', judgeStart)).split('\n').slice(1).map((l) => l.replace(/^ {10}/, '')).join('\n');
  const thresholds = Object.fromEntries([...code.slice(code.indexOf('env:'), code.indexOf('steps:')).matchAll(/^ {6}([A-Z_]+): "([^"]*)"$/gm)].map((m) => [m[1], m[2]]));
  const judge = (report) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hj-')), out = path.join(dir, 'out.txt'); fs.writeFileSync(out, '');
    if (report !== undefined) fs.writeFileSync(path.join(dir, 'health.json'), typeof report === 'string' ? report : JSON.stringify(report));
    execFileSync('python3', ['-'], { input: script, env: { ...process.env, ...thresholds, RESULTS: dir, GITHUB_OUTPUT: out }, stdio: ['pipe', 'pipe', 'pipe'] });
    return { ...JSON.parse(fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8')), output: fs.readFileSync(out, 'utf8').trim() };
  };
  const now = '2026-10-14T12:00:00.000Z';
  const good = { business: 'zulu-co', generatedAt: now, hourlyJob: { lastRunAt: '2026-10-14T11:30:00.000Z', minutesSinceLastRun: 30, lastOk: true, lastError: null, nextAlarmAt: '2026-10-14T12:30:00.000Z' }, memoryQueue: { pending: 2, oldestPendingMinutes: 5 }, requests: { recent: 100, serverErrors: 1, errorRate: 0.01 }, backup: { lastAttemptOk: true, newestAgeHours: 6 }, model: { today: { estimatedUsd: 0.4 } } };
  const mod = (patch) => JSON.parse(JSON.stringify({ ...good, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...good[k], ...v } : v])) }));

  check(Object.keys(thresholds).length === 8 && thresholds.JOB_STALE_MINUTES === '150' && thresholds.BACKUP_STALE_HOURS === '30' && thresholds.ERROR_RATE_LIMIT === '0.2', 'the thresholds are in the workflow where they can be read and changed (eight of them)');
  const healthy = judge(good);
  check(healthy.healthy === true && healthy.output === 'healthy=true' && healthy.problems.length === 0 && healthy.warnings.length === 0, 'a healthy business is called healthy, with no problems and no warnings');
  const cases = [
    ['the hourly job failed', mod({ hourlyJob: { lastOk: false, lastError: 'embedding failed' } }), /hourly job FAILED: embedding failed/],
    ['the hourly job went stale', mod({ hourlyJob: { minutesSinceLastRun: 200, lastRunAt: '2026-10-14T08:40:00.000Z', nextAlarmAt: '2026-10-14T12:30:00.000Z' } }), /last ran 200 minutes ago/],
    ['the alarm is overdue (stuck)', mod({ hourlyJob: { nextAlarmAt: '2026-10-14T11:00:00.000Z' } }), /overdue by 60 minutes/],
    ['the job never ran and none is scheduled', mod({ hourlyJob: { lastRunAt: null, minutesSinceLastRun: null, lastOk: null, nextAlarmAt: null } }), /never run and no run is scheduled/],
    ['the oldest memory has waited too long', mod({ memoryQueue: { pending: 5, oldestPendingMinutes: 240 } }), /waited 240 minutes/],
    ['the memory queue is huge', mod({ memoryQueue: { pending: 900, oldestPendingMinutes: 10 } }), /900 memories are waiting/],
    ['server errors are rising', mod({ requests: { recent: 50, serverErrors: 20, errorRate: 0.4 } }), /server errors are 0\.4 of the last 50/],
    ['the last backup failed', mod({ backup: { lastAttemptOk: false, lastError: 'the backup bucket is full' } }), /backup attempt FAILED: the backup bucket is full/],
    ['the newest backup is too old', mod({ backup: { newestAgeHours: 31 } }), /backup is 31 hours old/],
    ['there is no backup', mod({ backup: { newestAgeHours: null } }), /there is no backup/],
  ];
  check(cases.every(([, r, re]) => { const v = judge(r); return v.healthy === false && v.output === 'healthy=false' && v.problems.some((p) => re.test(p)); }), `it calls UNHEALTHY, with the reason, each of the ways a business can be: ${cases.map((c) => c[0]).join('; ')}`);
  const calm = [
    ['a job that has not run yet but IS scheduled (just deployed)', mod({ hourlyJob: { lastRunAt: null, minutesSinceLastRun: null, lastOk: null, nextAlarmAt: '2026-10-14T12:40:00.000Z' } })],
    ['a few errors in a small sample (3 of 6)', mod({ requests: { recent: 6, serverErrors: 3, errorRate: 0.5 } })],
    ['an alarm only slightly late (20 minutes)', mod({ hourlyJob: { nextAlarmAt: '2026-10-14T11:40:00.000Z' } })],
    ['a backup 29.9 hours old', mod({ backup: { newestAgeHours: 29.9 } })],
    ['a small, normal queue', mod({ memoryQueue: { pending: 40, oldestPendingMinutes: 100 } })],
  ];
  check(calm.every(([, r]) => judge(r).healthy === true), `it does NOT cry wolf: ${calm.map((c) => c[0]).join('; ')}`);
  const pricey = judge(mod({ model: { today: { estimatedUsd: 3.5 } } }));
  check(pricey.healthy === true && pricey.warnings.length === 1 && /cost about \$3\.5 today/.test(pricey.warnings[0]), 'a high model bill is a WARNING, not a failure (a spending cap is a separate decision)');
  check(judge('<html>502 Bad Gateway</html>').healthy === false && judge(undefined).healthy === false && judge({}).healthy === false && judge({ error: 'no such route' }).healthy === false, 'an unreadable report (an error page, nothing, an empty object, an error) is UNHEALTHY: silence is never taken for health');
  const triggers = code.slice(code.indexOf('on:'), code.indexOf('concurrency:'));
  check(/schedule:\s*\n\s*- cron: "7 \*\/3 \* \* \*"/.test(triggers) && /workflow_dispatch:/.test(triggers), 'it runs every three hours, and by hand');
  check(/PROD_URL: https:\/\/office\.websitehub\.co\.za/.test(code) && /BUSINESS: zululand-flooring-and-blinds/.test(code) && JSON.stringify(secretsOf(code)) === JSON.stringify(['PROD_ADMIN_KEY']) && !/-X\s*(POST|PUT|DELETE|PATCH)/i.test(code) && (code.match(/curl /g) || []).length === 1, 'it is fixed to production and the business, needs only the admin key, and makes exactly ONE request: a GET');
  check(/Go RED if something is wrong/.test(code) && /if: always\(\) && steps\.judge\.outputs\.healthy != 'true'/.test(code) && /if: always\(\) && github\.event_name == 'workflow_dispatch'/.test(code.slice(code.indexOf('name: Record what was found'))) && /git add ops\/production-health-last\.json/.test(code) && !/git add -A|git add \./.test(code), 'it goes RED when unhealthy (even if an earlier step failed), commits nothing on its schedule, and a manual run adds only its own record');
};
