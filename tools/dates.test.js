// Tests for the date reader (decided 2026-10-04): an ordinal word means exactly its digit form, so "the seventeenth" schedules the
// 17th as "the 17th" always has. Plus the guard that keeps everyday uses of "first" and "second" from becoming dates.
module.exports = async function runDateTests({ check, bundleTo }) {
  const { resolveScheduledDate, ordinalWordsToDigits } = bundleTo('scheduler.ts', 'rm-dates-scheduler.js');
  const now = new Date(2026, 9, 3, 12, 0, 0);   // Saturday 3 October 2026
  const words = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth', 'twenty first', 'twenty-second', 'twenty third', 'twenty-fourth', 'twenty fifth', 'twenty-sixth', 'twenty seventh', 'twenty-eighth', 'twenty ninth', 'thirtieth', 'thirty first'];
  const suffix = (d) => (d % 100 >= 11 && d % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[d % 10] || 'th'));
  let agree = 0, total = 0;
  words.forEach((w, i) => {
    const d = i < 20 ? i + 1 : i < 29 ? 21 + (i - 20) : i === 29 ? 30 : 31;
    const want = resolveScheduledDate(`the ${d}${suffix(d)}`, now);
    for (const phrase of [`the ${w}`, `${w} of the month`, `on the ${w}, please`, `THE ${w.toUpperCase()}`]) {
      total++;
      if (want !== null && resolveScheduledDate(phrase, now) === want) agree++;
      else check(false, `"${phrase}" must read as the ${d}${suffix(d)} (got ${resolveScheduledDate(phrase, now)}, the digit form gives ${want})`);
    }
  });
  check(agree === total && total === 124, `every day from the first to the thirty-first, in words, reads exactly as its digit form (${agree} of ${total} phrasings)`);
  // The everyday words are not dates unless they stand alone or are followed by "of".
  for (const phrase of ['the first job', 'a second coat', 'the second thing', 'second coat of paint', 'the first coat', 'do the second room']) {
    check(resolveScheduledDate(phrase, now) === null, `"${phrase}" is not a date`);
  }
  check(resolveScheduledDate('first thing monday', now) === '2026-10-05', '"first thing Monday" is Monday, not the 1st');
  check(resolveScheduledDate('the first', now) === '2026-11-01' && resolveScheduledDate('the second.', now) === '2026-11-02', '"the first" and "the second." standing alone are dates');
  check(resolveScheduledDate('the seventeenth tomorrow', now) === '2026-10-04', 'a stronger word still wins ("tomorrow" before a day of the month), exactly as with digits');
  check(ordinalWordsToDigits('twenty-first and thirty first and thirtieth') === '21th and 31th and 30th', 'compound ordinals are read before the simple ones (no "twenty 1st")');
  check(ordinalWordsToDigits('the 17th') === 'the 17th' && ordinalWordsToDigits('') === '', 'a phrase with no ordinal words is unchanged');
};
