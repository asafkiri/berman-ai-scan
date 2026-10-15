// Compare printed evidence only. Never use catalog prices to repair OCR.
// v8: for a client that sets dateDefaults (app 142+, which falls back to the
// receiving day on its own), docDate is still read and returned, but it is not one
// of the compared or required fields. A date the reads could not settle never pays
// for the stronger read and never holds the status in needs_review on its own; it
// is reported separately (verification.docDateUnreliable). A request without the
// flag (app 141 and older, which does not read docDateUnreliable) gets v7's date
// checks unchanged — so the merge order of server and app does not matter.
const documentFields = ['docNumber', 'docType', 'pageCount', 'totalUnits',
  'printedLines', 'netToChargeExVat', 'vatAmountPrinted', 'totalToChargeInclVat'];
const documentFieldsWithDate = ['docNumber', 'docType', 'docDate', 'pageCount', 'totalUnits',
  'printedLines', 'netToChargeExVat', 'vatAmountPrinted', 'totalToChargeInclVat'];
const rowFields = ['sourcePage', 'lineNumber', 'itemCode', 'barcode', 'quantity', 'unitPriceExVat'];
const docFieldsFor = dateDefaults => dateDefaults ? documentFields : documentFieldsWithDate;

function normalized(field, value) {
  if (value == null) return null;
  // v7's date comparison (requests without dateDefaults): format differences are not disagreements
  if (field === 'docDate') {
    const date = String(value).trim();
    const m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/.exec(date);
    return m ? `${m[3].length === 2 ? '20' : ''}${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : date;
  }
  return typeof value === 'string' ? value.trim() : value;
}
// The printed date as an ISO day, or null when it is not a real calendar date.
// Same rules as the client's priceAuditDate (berman-app), so "read" means the
// same thing on both sides: 31/02/2026 is not a date, 14/09/26 is 2026-09-14.
export function docDateIso(value) {
  const s = String(value || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s), y, month, day;
  if (m) { y = +m[1]; month = +m[2]; day = +m[3]; }
  else {
    m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/.exec(s);
    if (!m) return null;
    y = +m[3]; if (y < 100) y += 2000; month = +m[2]; day = +m[1];
  }
  const d = new Date(Date.UTC(y, month - 1, day));
  return d.getUTCFullYear() === y && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d.toISOString().slice(0, 10) : null;
}
// v8: the final read's docDate against every other successful read of the request.
// A read without a date neither confirms nor disputes.
//   unreliable — documents whose day the client should not use as the receiving day:
//     'unreadable': no read has a usable day (the final read has no real calendar date,
//       and the other reads read none, or more than one).
//     'disputed': another read read a different date and none read the final one.
//   read — the final read has no date, but the other reads read exactly one day (every
//     one that read a date read that day): { noteIndex, day }. Nothing disputes it, so
//     it is not 'unreadable' — the same rule the client applies to its own verify read
//     (__bermanDocDateRead). Which of the parallel reads happened to miss the date no
//     longer decides the outcome.
// The delivery day is not known here, so "after the delivery day" is the client's check.
// Nothing is changed in the scan itself: the final read's printed value stays as read.
export function judgeDocDates(scan, others = []) {
  const unreliable = [], read = [];
  for (const doc of (scan && scan.documents) || []) {
    if (!doc) continue;
    const day = docDateIso(doc.docDate);
    const seen = others.map(other => ((other && other.documents) || []).find(d => d && d.noteIndex === doc.noteIndex))
      .map(d => d ? docDateIso(d.docDate) : null).filter(Boolean);
    if (!day) {
      const days = [...new Set(seen)];
      if (days.length === 1) read.push({ noteIndex: doc.noteIndex, day: days[0] });
      else unreliable.push({ noteIndex: doc.noteIndex, reason: 'unreadable' });
      continue;
    }
    if (seen.length && !seen.includes(day)) unreliable.push({ noteIndex: doc.noteIndex, reason: 'disputed' });
  }
  return { unreliable, read };
}
export function unreliableDocDates(scan, others = []) { return judgeDocDates(scan, others).unreliable; }
function orderedRows(doc) {
  return (doc.rows || []).map((row, rowIndex) => ({ row, rowIndex })).sort((a, b) => {
    const page = a.row.sourcePage - b.row.sourcePage;
    if (page) return page;
    if (a.row.lineNumber != null && b.row.lineNumber != null) return a.row.lineNumber - b.row.lineNumber;
    const key = r => JSON.stringify(rowFields.map(f => normalized(f, r[f])));
    return key(a.row).localeCompare(key(b.row));
  });
}
function issue(doc, field, reason, entry) {
  return { noteIndex: doc.noteIndex, field, reason,
    ...(entry ? { rowIndex: entry.rowIndex, sourcePage: entry.row.sourcePage, lineNumber: entry.row.lineNumber } : {}) };
}
export function compareScans(a, b, { dateDefaults = false } = {}) {
  const issues = [];
  for (const doc of a.documents) {
    const other = b.documents.find(d => d.noteIndex === doc.noteIndex);
    if (!other) { issues.push(issue(doc, 'document', 'disagreement')); continue; }
    for (const field of docFieldsFor(dateDefaults)) {
      if (normalized(field, doc[field]) !== normalized(field, other[field])) issues.push(issue(doc, field, 'disagreement'));
    }
    const left = orderedRows(doc), right = orderedRows(other);
    if (left.length !== right.length) { issues.push(issue(doc, 'rows', 'disagreement')); continue; }
    left.forEach((entry, index) => {
      for (const field of rowFields) {
        if (normalized(field, entry.row[field]) !== normalized(field, right[index].row[field])) {
          issues.push(issue(doc, field, 'disagreement', entry));
        }
      }
    });
  }
  return issues;
}
export function inspectScan(scan, documents, checksum, { dateDefaults = false } = {}) {
  const issues = [];
  for (const doc of scan.documents) {
    // v8 (dateDefaults): no docDate here — an unread date is reported in docDateUnreliable instead.
    const required = dateDefaults ? ['docNumber', 'totalUnits', 'printedLines', 'netToChargeExVat']
      : ['docNumber', 'docDate', 'totalUnits', 'printedLines', 'netToChargeExVat'];
    for (const field of required) {
      if (doc[field] == null || doc[field] === '') issues.push(issue(doc, field, 'unreadable'));
    }
    if (doc.docType === 'unknown') issues.push(issue(doc, 'docType', 'unreadable'));
    if (doc.confidence < 0.8) issues.push(issue(doc, 'document', 'low_confidence'));
    if ([doc.netToChargeExVat, doc.vatAmountPrinted, doc.totalToChargeInclVat].every(Number.isFinite)
      && Math.abs(Math.round(doc.netToChargeExVat * 100) + Math.round(doc.vatAmountPrinted * 100)
        - Math.round(doc.totalToChargeInclVat * 100)) > 2) issues.push(issue(doc, 'totals', 'inconsistent'));
    doc.rows.forEach((row, rowIndex) => {
      const entry = { row, rowIndex };
      if (!row.itemCode && !row.barcode) issues.push(issue(doc, 'identity', 'unreadable', entry));
      if (!(row.quantity > 0)) issues.push(issue(doc, 'quantity', 'unreadable', entry));
      if (row.unitPriceExVat == null || row.unitPriceExVat < 0) issues.push(issue(doc, 'unitPriceExVat', 'unreadable', entry));
      if (row.confidence < 0.8) issues.push(issue(doc, 'row', 'low_confidence', entry));
    });
  }
  for (const mismatch of checksum(scan, documents)) {
    if (mismatch.unitsOff) issues.push({ noteIndex: mismatch.noteIndex, field: 'totalUnits', reason: 'inconsistent' });
    if (mismatch.linesOff) issues.push({ noteIndex: mismatch.noteIndex, field: 'printedLines', reason: 'inconsistent' });
  }
  return issues;
}
export function totalUsage(reads) {
  const known = reads.filter(r => r.usage);
  if (!known.length) return null;
  return Object.fromEntries(['input_tokens', 'output_tokens', 'total_tokens'].map(field =>
    [field, known.reduce((n, r) => n + (Number(r.usage[field]) || 0), 0)]));
}
export function verificationPrompt(targets = []) {
  const fields = { unitPriceExVat: 'מחיר היחידה', quantity: 'הכמות', itemCode: 'קוד הפריט', barcode: 'הברקוד',
    totalUnits: 'סך היחידות', printedLines: 'מספר השורות', netToChargeExVat: 'נטו לחיוב',
    totals: 'שלוש שורות הסכומים', docDate: 'תאריך התעודה', docNumber: 'מספר התעודה' };
  const locations = targets.slice(0, 50).map(t => `מסמך ${t.noteIndex + 1}`
    + (t.sourcePage ? ` עמוד ${t.sourcePage}` : '') + (t.lineNumber != null ? ` שורה מודפסת ${t.lineNumber}` : '')
    + ': ' + (fields[t.field] || 'קריאת השדות המודפסים')).join('; ');
  return 'בצע קריאה עצמאית חדשה של הצילום המקורי. קרא את כל השורות ואת הסיכום. '
    + 'בדוק במיוחד ספרות דומות במחירים, בכמויות ובקודים. אל תנחש ספרה לא קריאה ואל תשנה שום מספר כדי להתאים לסיכום. '
    + 'לא נמסרים לך מחירים צפויים או תשובות קודמות. ' + locations;
}

// Three reads transcribing the same cell character-for-character is stronger
// evidence than any single read's self-scored confidence, and the pair is already
// paid for on every scan. So agreement is allowed to clear 'low_confidence' — and
// nothing else. Every issue that carries real evidence (an unreadable cell, a
// totals or checksum inconsistency, a disagreement) keeps its full blocking power,
// and a strong read that drifts from the pair re-arms the flag instead of hiding.
// Below the floor the model is not hedging, it is saying it could not see the
// cell; three correlated guesses do not answer that, so it still reaches the user.
const AGREEMENT_CONFIDENCE_FLOOR = 0.5;
function rowKey(doc, row) {
  return JSON.stringify([doc.noteIndex, rowFields.map(field => normalized(field, row[field]))]);
}
// v8 (dateDefaults): the compared fields no longer hold docDate, so three reads that
// agree on every other summary field clear a low document confidence even when the
// dates differ. The date's own doubt is reported in docDateUnreliable, not here.
function docKey(doc, dateDefaults) {
  return JSON.stringify([doc.noteIndex, docFieldsFor(dateDefaults).map(field => normalized(field, doc[field]))]);
}
function tallies(scan, keysOf) {
  const counts = new Map();
  for (const doc of scan.documents || []) for (const key of keysOf(doc)) counts.set(key, (counts.get(key) || 0) + 1);
  return counts;
}
// scans[0] is the read being inspected. A tuple counts as agreed only when every
// other read holds it at least as often, so one of two identical product lines
// can never borrow the other's proof.
function agreedTuples(scans, keysOf) {
  const [mine, ...others] = scans.map(scan => tallies(scan, keysOf));
  const agreed = new Set();
  for (const [key, count] of mine) if (others.every(other => (other.get(key) || 0) >= count)) agreed.add(key);
  return key => agreed.has(key);
}
// Keyed on the normalized printed fields, never on rowIndex across reads: each
// read sorts its own rows, so a positional key would silently pair up the wrong
// lines. Inside `scan` itself rowIndex is exact, and that is the only way it is used.
function withoutAgreedConfidence(issues, scan, others, dateDefaults = false) {
  const scans = [scan, ...others.filter(other => other !== scan)];
  if (scans.length < 3) return issues;
  const rowAgreed = agreedTuples(scans, doc => (doc.rows || []).map(row => rowKey(doc, row)));
  const docAgreed = agreedTuples(scans, doc => [docKey(doc, dateDefaults)]);
  const byNote = new Map((scan.documents || []).map(doc => [doc.noteIndex, doc]));
  return issues.filter(item => {
    if (item.reason !== 'low_confidence') return true;
    const doc = byNote.get(item.noteIndex);
    if (!doc) return true;
    if (item.field === 'document') return !(doc.confidence >= AGREEMENT_CONFIDENCE_FLOOR && docAgreed(docKey(doc, dateDefaults)));
    const row = item.rowIndex == null ? null : (doc.rows || [])[item.rowIndex];
    if (!row) return true;
    return !(row.confidence >= AGREEMENT_CONFIDENCE_FLOOR && rowAgreed(rowKey(doc, row)));
  });
}

// Which issues made the stronger (paid) read happen. The issues list kept in the
// response is what is still open after that read; without this record there is no
// way to tell, a week later, whether a third read was caused by a price, a code,
// a quantity or a self-scored confidence. moneyOnly marks the escalations that only
// money fields caused: the client no longer uses printed money to decide anything
// (it is kept for identification), so these are the reads that reading prices costs.
const MONEY_FIELDS = new Set(['unitPriceExVat', 'netToChargeExVat', 'vatAmountPrinted', 'totalToChargeInclVat', 'totals']);
const TRIGGER_LIMIT = 60;
export function escalationTriggers(issues) {
  const seen = new Set(), triggers = [], summary = {};
  let moneyOnly = true;
  for (const item of issues || []) {
    if (!item) continue;
    const t = { noteIndex: item.noteIndex, field: item.field, reason: item.reason,
      ...(item.rowIndex != null ? { rowIndex: item.rowIndex } : {}),
      ...(item.sourcePage != null ? { sourcePage: item.sourcePage } : {}),
      ...(item.lineNumber != null ? { lineNumber: item.lineNumber } : {}) };
    const key = JSON.stringify(t);
    if (seen.has(key)) continue;
    seen.add(key);
    const tag = t.reason + ':' + t.field;
    summary[tag] = (summary[tag] || 0) + 1;
    if (!MONEY_FIELDS.has(t.field)) moneyOnly = false;
    if (triggers.length < TRIGGER_LIMIT) triggers.push(t);
  }
  return { triggers, triggerSummary: summary, moneyOnly: seen.size > 0 && moneyOnly, triggersTruncated: seen.size > triggers.length };
}

// One upload, two independent base calls, at most one stronger read.
// dateDefaults: the client sets its own day for a date that was not read well (app 142+);
// without it the date is checked exactly as in v7 (see the top of this file).
export async function runVerifiedScan({ attemptScan, documents, checksum, verificationOnly = false, targets = [], dateDefaults = false }) {
  const opts = { dateDefaults: dateDefaults === true };
  const reads = [], scans = [];
  const read = async (escalate, pass) => {
    const result = await attemptScan(escalate ? verificationPrompt(targets) :
      (pass === 2 ? 'קרא באופן עצמאי את כל התאים המודפסים. לאחר החילוץ בדוק שוב את עמודות המחיר, הכמות והקוד מול הצילום, ללא תיקון לפי חישוב.' : null),
    escalate ? 'high' : 'medium', escalate);
    reads.push({ model: result.data?.model || result.callModel || null,
      requestId: result.data?.id || result.fail?.body?.requestId || null,
      usage: result.data?.usage || null, escalation: escalate, error: result.fail?.body?.error || null });
    if (result.scan) scans.push(result.scan);
    return result;
  };
  let selected, issues = [], escalationAttempted = verificationOnly, agreementScans = [], escalation = null, notDriverStrip = false;
  if (verificationOnly) {
    // The client asked for this read itself; its targets are the trigger.
    // Only the validated target fields are recorded; anything else on a target
    // (a reason, a rowIndex) is the client's own text and is not echoed back.
    escalation = escalationTriggers((targets || []).map(t => t && ({ noteIndex: t.noteIndex, field: t.field,
      sourcePage: t.sourcePage, lineNumber: t.lineNumber, reason: 'client_request' })));
    selected = await read(true);
  }
  else {
    const pair = await Promise.all([read(false, 1), read(false, 2)]);
    const good = pair.filter(r => r.scan);
    selected = good[0] || pair[0];
    if (good.length === 2) { issues.push(...compareScans(good[0].scan, good[1].scan, opts)); agreementScans = good.map(r => r.scan); }
    else issues.push({ noteIndex: 0, field: 'document', reason: 'read_failed' });
    for (const result of good) issues.push(...inspectScan(result.scan, documents, checksum, opts));
    // v7: both cheap reads say the photo is not a driver strip at all (an A4 invoice,
    // a promo letter) — and both returned exactly that: no header class, no rows. A
    // stronger read cannot turn such a page into a strip, so it is not paid for. The
    // flag alone is never trusted: a read that set it but still returned rows or a
    // docType goes through the normal path, and the skipped issues stay in the result
    // so the status is always needs_review.
    notDriverStrip = good.length === 2 && good.every(r => (r.scan.documents || []).length > 0
      && r.scan.documents.every(d => d.notDriverStrip === true && d.docType === 'unknown' && !(d.rows || []).length));
    if (issues.length && !notDriverStrip) {
      targets = issues;
      escalationAttempted = true;
      escalation = escalationTriggers(issues);
      const strong = await read(true);
      if (strong.scan) selected = strong;
      else if (!selected.scan) selected = strong;
      // Failure must not silently turn one disputed cheap read into agreement.
      if (strong.fail && selected.scan) selected = { ...selected, verificationFailed: true };
    }
  }
  const remaining = selected.scan ? inspectScan(selected.scan, documents, checksum, opts) : issues;
  if (selected.verificationFailed) remaining.push(...issues);
  // A skipped A4 page keeps what the two reads disagreed on, without repeating what is already there.
  else if (notDriverStrip) {
    const seen = new Set(remaining.map(i => JSON.stringify(i)));
    for (const item of issues) if (!seen.has(JSON.stringify(item))) { seen.add(JSON.stringify(item)); remaining.push(item); }
  }
  // A failed verification leaves no third transcription to agree with, so that
  // path keeps its full strictness rather than clearing anything on a pair alone.
  const evidenced = selected.scan && !selected.verificationFailed
    ? withoutAgreedConfidence(remaining, selected.scan, agreementScans, opts.dateDefaults) : remaining;
  const status = !selected.scan || evidenced.length ? 'needs_review' : escalationAttempted ? 'verified' : 'agreed';
  // v8: the final read's date against every other successful read of this request
  // (the cheap pair, and the stronger read when it ran). Reported, never gating by itself
  // (without dateDefaults the date also stays in the issues above, as in v7).
  const otherScans = scans.slice(), own = otherScans.indexOf(selected.scan);
  if (own >= 0) otherScans.splice(own, 1);
  const dates = selected.scan ? judgeDocDates(selected.scan, otherScans) : { unreliable: [], read: [] };
  return { selected, verification: { version: 1, status, primaryReads: verificationOnly ? 0 : 2,
    escalationAttempted, reasons: [...new Set(issues.map(i => i.reason))], issues: evidenced,
    agreementCleared: remaining.length - evidenced.length, docDateUnreliable: dates.unreliable, docDateRead: dates.read, dateDefaults: opts.dateDefaults,
    readCount: reads.length, ...(notDriverStrip ? { notDriverStrip: true } : {}), ...(escalation || {}) }, reads, usage: totalUsage(reads) };
}
