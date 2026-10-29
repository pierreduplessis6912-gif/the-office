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

  // ---- Times, durations and amounts are not days (decided 2026-10-04) --------------------------------------------
  let timeOk = 0, timeTotal = 0;
  for (let h = 1; h <= 12; h++) {
    for (const phrase of [`${h} pm on the 17th`, `${h}pm on the 17th`, `${h} am the 17th`, `at ${h}:30 on the 17th`, `the 17th at ${h}:45`, `${h} o'clock on the 17th`]) {
      timeTotal++;
      if (resolveScheduledDate(phrase, now) === '2026-10-17') timeOk++; else check(false, `"${phrase}" must be the 17th, not the ${h}th (got ${resolveScheduledDate(phrase, now)})`);
    }
  }
  check(timeOk === timeTotal && timeTotal === 72, `a time of day beside a date is never read as the day (${timeOk} of ${timeTotal} phrasings)`);
  // DECISION CHANGED by Pierre 2026-10-29: "3 days from now" and "2 weeks from now" ARE dates (the 2026-10-04 decision read them as durations, so a job said that way stayed undated). A length of time with no "in" or "from now" still is not a date.
  for (const phrase of ['in about 3 hours', '10 minutes']) check(resolveScheduledDate(phrase, now) === null, `"${phrase}" is a duration, not a date`);
  check(resolveScheduledDate('3 days from now', now) === '2026-10-06' && resolveScheduledDate('2 weeks from now', now) === '2026-10-17', '"3 days from now" and "2 weeks from now" are dates (Pierre 2026-10-29)');
  for (const phrase of ['install 20 sqm on the 17th', '2 boxes on the 17th', '12 bags on the 17th', '3 rolls of underlay on the 17th']) check(resolveScheduledDate(phrase, now) === '2026-10-17', `"${phrase}": an amount of something is not the day`);
  // The amount guard matters when the date has no ordinal ending, which is when the ordinal preference cannot help.
  for (const phrase of ['20 sqm on the 17', '2 boxes on 17', '12 bags on the 17', '3 rolls of underlay on 17', '20 m2 for the 17']) check(resolveScheduledDate(phrase, now) === '2026-10-17', `"${phrase}": with no ordinal ending, the amount must still not be read as the day`);
  check(resolveScheduledDate('3 rooms on the 17th', now) === '2026-10-17' && resolveScheduledDate('2 men for the 17th', now) === '2026-10-17', 'a bare number beside a date with an ordinal ending loses to the ordinal ("3 rooms on the 17th")');
  check(resolveScheduledDate('the 10th', now) === '2026-10-10' && resolveScheduledDate('17', now) === '2026-10-17' && resolveScheduledDate('on the 17', now) === '2026-10-17', 'a plain day, with or without an ordinal ending, is read exactly as before');
  check(resolveScheduledDate('the 5th at 3 pm', now) === '2026-10-05' && resolveScheduledDate('the 20 sqm job on the 4th', now) === '2026-10-04', 'the ordinal is found wherever it falls in the phrase');
  check(resolveScheduledDate('in 3 days', now) === '2026-10-06' && resolveScheduledDate('tomorrow', now) === '2026-10-04', '"in 3 days" and "tomorrow" are unchanged (they are read before any day number)');

  // ---- ISO dates and number words in "in <count> <unit>" (found 2026-10-29 by the Office read baseline) ---------------------------------------------
  // A job asked for on 2026-10-29 was recorded as "Tue 10 Nov": the day reader took the FIRST number (10, the month) as the day. "in two weeks" read as no date at all (left the job undated), "in 2 weeks" as the 17th.
  const iso = (p) => resolveScheduledDate(p, now);
  check(iso('2026-10-29') === '2026-10-29' && iso('2026-11-08') === '2026-11-08' && iso('2027-01-15') === '2027-01-15' && iso('2026-10-03') === '2026-10-03', 'an ISO date (YYYY-MM-DD) is that date, not the month taken as the day (was 10 Nov, 11 Nov, 1 Nov)');
  check(iso('on 2026-11-08 at 9 am') === '2026-11-08' && iso('Monday 2026-11-09') === '2026-11-09' && iso('book it for 2026-12-01, 20 sqm') === '2026-12-01', 'wherever it falls in the phrase, and an ISO date beats a weekday or a number beside it');
  check(iso('2026-13-45') === null && iso('2026-02-30') === null && iso('2026-04-31') === null && iso('2028-02-29') === '2028-02-29' && iso('2026-02-29') === null, 'an impossible ISO date is no date (never misread as another day), and a real leap day is one');
  check(iso('2026-09-30') === '2026-09-30', 'a past ISO date is returned as it was said, not moved to next year or next month');
  const inN = [['in 2 weeks', '2026-10-17'], ['in two weeks', '2026-10-17'], ['in three days', '2026-10-06'], ['in 3 days', '2026-10-06'], ['in a week', '2026-10-10'], ['in one week', '2026-10-10'], ['in a fortnight', '2026-10-17'], ['in twelve days', '2026-10-15'], ['in Two Weeks time', '2026-10-17'], ['in an day', null]];
  const bad = inN.filter(([p, want]) => iso(p) !== want);
  check(bad.length === 0, 'a count in words or "a week" or "a fortnight" works exactly like the digits: ' + bad.map(([p, w]) => `"${p}" gave ${iso(p)} not ${w}`).join('; '));
  for (const phrase of ['it will take two weeks', 'two weeks', 'the job takes three days', 'a fortnight', 'in about three hours', 'in two minutes']) check(iso(phrase) === null, `"${phrase}" is a length of time or not a day count, never a date`);
  check(iso('tomorrow') === '2026-10-04' && iso('in 3 days') === '2026-10-06' && iso('the 10th') === '2026-10-10' && iso('Thursday 17 November') === '2026-11-17' && iso('next week monday') === '2026-10-12', 'everything decided before is unchanged');

  // ---- "<count> <unit> from now / from today" is a date (Pierre, 2026-10-29) -----------------------------------------------------------------------
  const fromNow = [['3 days from now', '2026-10-06'], ['2 weeks from now', '2026-10-17'], ['three weeks from now', '2026-10-24'], ['five days from today', '2026-10-08'], ['ten days from now', '2026-10-13'], ['a week from now', '2026-10-10'], ['a week from today', '2026-10-10'], ['a fortnight from now', '2026-10-17'], ['1 day from now', '2026-10-04'], ['Install it 4 days from now please', '2026-10-07'], ['march 3 days from now', '2026-10-06']];
  const badFrom = fromNow.filter(([p, want]) => resolveScheduledDate(p, now) !== want);
  check(badFrom.length === 0, 'a count of days or weeks "from now" or "from today" is that many days on: ' + badFrom.map(([p, w]) => `"${p}" gave ${resolveScheduledDate(p, now)} not ${w}`).join('; '));
  for (const phrase of ['it will take 3 days', 'the job is 2 weeks long', '3 days', 'two weeks', 'in about 3 hours', '2 hours from now', '30 minutes from now']) check(resolveScheduledDate(phrase, now) === null, `"${phrase}" is a length of time or an hour count, still not a date`);
  check(resolveScheduledDate('today', now) === '2026-10-03' && resolveScheduledDate('do it today', now) === '2026-10-03' && resolveScheduledDate('tomorrow', now) === '2026-10-04', '"today" and "tomorrow" alone are unchanged (the "from today" form is read before the word "today")');
};
