// Guards on the two production workflows for the backups: the one that creates the separate bucket, and the daily check (the ALERT) that can also take a snapshot by hand. The check must be read-only on its
// schedule, must go red on every way the backups can be unhealthy, may write only when asked by hand, and must never restore.
module.exports = async function runProdBackupTests({ check, path, fs }) {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', f), 'utf8').replace(/^\s*#.*$/gm, '');
  const bucket = read('prod-create-backup-bucket.yml'), daily = read('prod-backup.yml');
  const secretsOf = (code) => [...new Set([...code.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]))].sort();
  check(/workflow_dispatch:/.test(bucket) && !/schedule:|push:/.test(bucket.slice(0, bucket.indexOf('concurrency:'))) && /BUCKET: office-backups/.test(bucket) && /wrangler r2 bucket create "\$BUCKET"/.test(bucket) && !/bucket delete|object delete|\brm\s/.test(bucket) && JSON.stringify(secretsOf(bucket)) === JSON.stringify(['CLOUDFLARE_ACCOUNT_ID', 'PROVISION']), 'the bucket workflow is manual, creates only the backup bucket (office-backups, separate from the files), deletes nothing, and uses only the Cloudflare credentials');
  const triggers = daily.slice(daily.indexOf('on:'), daily.indexOf('concurrency:'));
  check(/schedule:\s*\n\s*- cron: "\d+ \d+ \* \* \*"/.test(triggers) && /workflow_dispatch:/.test(triggers) && /options:\s*\n\s*- status\s*\n\s*- run/.test(triggers), 'the backup check runs EVERY DAY on a schedule (the alert), and by hand with a choice of status or run');
  check(/PROD_URL: https:\/\/office\.websitehub\.co\.za/.test(daily) && /BUSINESS: zululand-flooring-and-blinds/.test(daily) && JSON.stringify(secretsOf(daily)) === JSON.stringify(['PROD_ADMIN_KEY']), 'it is fixed to production and the business, and needs only the admin key (not the second one: it reads, or takes a snapshot, and never changes who has access)');
  const posts = [...daily.matchAll(/-X\s*(POST|PUT|DELETE|PATCH)\s+"([^"]+)"/gi)];
  const runStep = daily.slice(daily.indexOf('name: Take a snapshot now'), daily.indexOf('name: Read the backup status'));
  check(posts.length === 1 && /\/admin\/backup\/run$/.test(posts[0][2]) && /if: github\.event_name == 'workflow_dispatch' && inputs\.action == 'run'/.test(runStep) && !/restore|unlock/.test(daily), 'its ONLY write is taking a snapshot, and only on a manual run that asked for it; it can never restore or unlock');
  const judge = daily.slice(daily.indexOf('name: Judge the backups'), daily.indexOf('name: Record what was found'));
  check(/backupBucketConfigured/.test(judge) && /lastAttemptOk/.test(judge) && /no complete snapshot/.test(judge) && /newestAgeHours/.test(judge) && /hours old/.test(judge) && /STALE_AFTER_HOURS: "30"/.test(daily), 'it judges all four ways the backups can fail: no bucket, the last attempt failed, no complete snapshot, the newest more than 30 hours old');
  check(/Go RED if the backups are not healthy/.test(daily) && /if: always\(\) && steps\.judge\.outputs\.healthy != 'true'/.test(daily) && /exit 1/.test(daily.slice(daily.indexOf('Go RED'))), 'when they are not healthy the workflow goes RED (GitHub emails the owner), even if an earlier step failed');
  // The judging script is RUN, not just read: the alert is the one part whose silent failure would defeat the point of having backups.
  const { execFileSync } = require('child_process'), os = require('os');
  const script = daily.slice(daily.indexOf("python3 - <<'PY'", daily.indexOf('name: Judge the backups')), daily.indexOf('\n          PY', daily.indexOf('name: Judge the backups'))).split("\n").slice(1).map((l) => l.replace(/^ {10}/, '')).join("\n");
  const judgeWith = (status) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-')), out = path.join(dir, 'out.txt'); fs.writeFileSync(out, '');
    if (status !== undefined) fs.writeFileSync(path.join(dir, 'status.json'), typeof status === 'string' ? status : JSON.stringify(status));
    execFileSync('python3', ['-'], { input: script, env: { ...process.env, RESULTS: dir, STALE_AFTER_HOURS: '30', GITHUB_OUTPUT: out }, stdio: ['pipe', 'pipe', 'pipe'] });
    return { ...JSON.parse(fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8')), output: fs.readFileSync(out, 'utf8').trim() };
  };
  const good = { backupBucketConfigured: true, lastAttemptOk: true, complete: 3, newestAgeHours: 5, keep: 14 };
  const verdicts = {
    healthy: judgeWith(good), noBucket: judgeWith({ ...good, backupBucketConfigured: false }), failed: judgeWith({ ...good, lastAttemptOk: false, lastError: 'the backup bucket is full' }),
    noSnapshot: judgeWith({ ...good, complete: 0, newestAgeHours: null }), stale: judgeWith({ ...good, newestAgeHours: 31 }), justInTime: judgeWith({ ...good, newestAgeHours: 29.9 }), noAge: judgeWith({ ...good, newestAgeHours: null }),
    garbage: judgeWith('<html>502 Bad Gateway</html>'), missing: judgeWith(undefined), neverTried: judgeWith({ ...good, lastAttemptOk: null }),
  };
  check(verdicts.healthy.healthy === true && verdicts.healthy.output === 'healthy=true' && verdicts.healthy.problems.length === 0, 'the judge calls a good night healthy');
  check([['noBucket', /no backup bucket/], ['failed', /FAILED: the backup bucket is full/], ['noSnapshot', /no complete snapshot/], ['stale', /31 hours old/], ['noAge', /no age/]].every(([k, re]) => verdicts[k].healthy === false && verdicts[k].output === 'healthy=false' && verdicts[k].problems.some((p) => re.test(p))), 'it calls UNHEALTHY, with the reason, each way the backups can fail: no bucket, the last attempt failed, no snapshot, a snapshot more than 30 hours old, a snapshot with no age');
  check(verdicts.justInTime.healthy === true && verdicts.neverTried.healthy === true, 'it does not cry wolf: 29.9 hours old is fine, and a business whose backup has simply not been attempted yet but has a recent snapshot is fine');
  check(verdicts.garbage.healthy === false && verdicts.missing.healthy === false, 'and when the status cannot be read at all (an error page, or nothing) that is UNHEALTHY too: silence is never taken for health');
  const recordStep = daily.slice(daily.indexOf('name: Record what was found'), daily.indexOf('name: Go RED'));
  check(/if: always\(\) && github\.event_name == 'workflow_dispatch'/.test(recordStep) && /git add ops\/production-backup-last\.json/.test(recordStep) && !/git add -A|git add \./.test(recordStep) && !/KEY|SECRET|TOKEN|PASSWORD|EMAIL/.test(recordStep), 'the daily scheduled run commits nothing (no noise); a manual run records counts and statuses only');
};
