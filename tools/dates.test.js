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

  // ---- Named months (decided 2026-10-04) -----------------------------------------------------------------------
  const monthNames = [['january', 'jan', 0], ['february', 'feb', 1], ['march', 'mar', 2], ['april', 'apr', 3], ['may', 'may', 4], ['june', 'jun', 5], ['july', 'jul', 6], ['august', 'aug', 7], ['september', 'sept', 8], ['october', 'oct', 9], ['november', 'nov', 10], ['december', 'dec', 11]];
  let monthOk = 0, monthTotal = 0;
  for (const [full, abbr, idx] of monthNames) {
    for (const day of [1, 17, 28]) {
      const year = idx > 9 || (idx === 9 && day >= 3) ? 2026 : 2027;            // "now" is 3 October 2026: earlier dates are next year
      const want = `${year}-${String(idx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      for (const phrase of [`the ${day}th of ${full}`, `${day} ${abbr}`, `${full} ${day}`, `${abbr}. ${day}th`]) {
        monthTotal++;
        if (resolveScheduledDate(phrase, now) === want) monthOk++; else check(false, `"${phrase}" must be ${want} (got ${resolveScheduledDate(phrase, now)})`);
      }
    }
  }
  check(monthOk === monthTotal && monthTotal === 144, `every month, full and abbreviated, in both orders, reads as that month (${monthOk} of ${monthTotal} phrasings)`);
  check(resolveScheduledDate('the seventeenth of November', now) === '2026-11-17' && resolveScheduledDate('twenty-first of december', now) === '2026-12-21', 'an ordinal word and a month together read as that date');
  check(resolveScheduledDate('3 October', now) === '2026-10-03', 'today, said with its month, is today (not next year)');
  check(resolveScheduledDate('2 October', now) === '2027-10-02' && resolveScheduledDate('3 January', now) === '2027-01-03', 'a date already gone by this year is next year');
  check(resolveScheduledDate('the 31st of November', now) === null && resolveScheduledDate('30 February', now) === null && resolveScheduledDate('29 February', now) === null, 'a day the month does not have is no date, not the 1st of the next month');
  check(resolveScheduledDate('29 February', new Date(2027, 9, 3, 12, 0, 0)) === '2028-02-29', 'but 29 February is a date when the next one is a leap year');
  check(resolveScheduledDate('Thursday 17 November', now) === '2026-11-17', 'an explicit day and month beat a weekday said beside them');
  check(resolveScheduledDate('I may do it Monday', now) === '2026-10-05' && resolveScheduledDate('we march on Friday', now) === '2026-10-09', '"may" and "march" as ordinary words are not months');
  check(resolveScheduledDate('may 17', now) === '2027-05-17', 'but "may 17" is the 17th of May');
  check(resolveScheduledDate('march 3 days from now', now) !== '2027-03-03', 'a number that is a duration is not a day of March');
  check(resolveScheduledDate('the 10th', now) === '2026-10-10' && resolveScheduledDate('in 3 days', now) === '2026-10-06' && resolveScheduledDate('next week monday', now) === '2026-10-12', 'phrases with no month are read exactly as before');
};
