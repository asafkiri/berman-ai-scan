// Compare printed evidence only. Never use catalog prices to repair OCR.
const documentFields = ['docNumber', 'docType', 'docDate', 'pageCount', 'totalUnits',
  'printedLines', 'netToChargeExVat', 'vatAmountPrinted', 'totalToChargeInclVat'];
const rowFields = ['sourcePage', 'lineNumber', 'itemCode', 'barcode', 'quantity', 'unitPriceExVat'];

function normalized(field, value) {
  if (value == null) return null;
  if (field === 'docDate') {
    const date = String(value).trim();
    const m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/.exec(date);
    return m ? `${m[3].length === 2 ? '20' : ''}${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : date;
  }
  return typeof value === 'string' ? value.trim() : value;
}
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
export function compareScans(a, b) {
  const issues = [];
  for (const doc of a.documents) {
    const other = b.documents.find(d => d.noteIndex === doc.noteIndex);
    if (!other) { issues.push(issue(doc, 'document', 'disagreement')); continue; }
    for (const field of documentFields) {
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
export function inspectScan(scan, documents, checksum) {
  const issues = [];
  for (const doc of scan.documents) {
    for (const field of ['docNumber', 'docDate', 'totalUnits', 'printedLines', 'netToChargeExVat']) {
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
function docKey(doc) {
  return JSON.stringify([doc.noteIndex, documentFields.map(field => normalized(field, doc[field]))]);
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
function withoutAgreedConfidence(issues, scan, others) {
  const scans = [scan, ...others.filter(other => other !== scan)];
  if (scans.length < 3) return issues;
  const rowAgreed = agreedTuples(scans, doc => (doc.rows || []).map(row => rowKey(doc, row)));
  const docAgreed = agreedTuples(scans, doc => [docKey(doc)]);
  const byNote = new Map((scan.documents || []).map(doc => [doc.noteIndex, doc]));
  return issues.filter(item => {
    if (item.reason !== 'low_confidence') return true;
    const doc = byNote.get(item.noteIndex);
    if (!doc) return true;
    if (item.field === 'document') return !(doc.confidence >= AGREEMENT_CONFIDENCE_FLOOR && docAgreed(docKey(doc)));
    const row = item.rowIndex == null ? null : (doc.rows || [])[item.rowIndex];
    if (!row) return true;
    return !(row.confidence >= AGREEMENT_CONFIDENCE_FLOOR && rowAgreed(rowKey(doc, row)));
  });
}

// One upload, two independent base calls, at most one stronger read.
export async function runVerifiedScan({ attemptScan, documents, checksum, verificationOnly = false, targets = [] }) {
  const reads = [];
  const read = async (escalate, pass) => {
    const result = await attemptScan(escalate ? verificationPrompt(targets) :
      (pass === 2 ? 'קרא באופן עצמאי את כל התאים המודפסים. לאחר החילוץ בדוק שוב את עמודות המחיר, הכמות והקוד מול הצילום, ללא תיקון לפי חישוב.' : null),
    escalate ? 'high' : 'medium', escalate);
    reads.push({ model: result.data?.model || result.callModel || null,
      requestId: result.data?.id || result.fail?.body?.requestId || null,
      usage: result.data?.usage || null, escalation: escalate, error: result.fail?.body?.error || null });
    return result;
  };
  let selected, issues = [], escalationAttempted = verificationOnly, agreementScans = [];
  if (verificationOnly) selected = await read(true);
  else {
    const pair = await Promise.all([read(false, 1), read(false, 2)]);
    const good = pair.filter(r => r.scan);
    selected = good[0] || pair[0];
    if (good.length === 2) { issues.push(...compareScans(good[0].scan, good[1].scan)); agreementScans = good.map(r => r.scan); }
    else issues.push({ noteIndex: 0, field: 'document', reason: 'read_failed' });
    for (const result of good) issues.push(...inspectScan(result.scan, documents, checksum));
    if (issues.length) {
      targets = issues;
      escalationAttempted = true;
      const strong = await read(true);
      if (strong.scan) selected = strong;
      else if (!selected.scan) selected = strong;
      // Failure must not silently turn one disputed cheap read into agreement.
      if (strong.fail && selected.scan) selected = { ...selected, verificationFailed: true };
    }
  }
  const remaining = selected.scan ? inspectScan(selected.scan, documents, checksum) : issues;
  if (selected.verificationFailed) remaining.push(...issues);
  // A failed verification leaves no third transcription to agree with, so that
  // path keeps its full strictness rather than clearing anything on a pair alone.
  const evidenced = selected.scan && !selected.verificationFailed
    ? withoutAgreedConfidence(remaining, selected.scan, agreementScans) : remaining;
  const status = !selected.scan || evidenced.length ? 'needs_review' : escalationAttempted ? 'verified' : 'agreed';
  return { selected, verification: { version: 1, status, primaryReads: verificationOnly ? 0 : 2,
    escalationAttempted, reasons: [...new Set(issues.map(i => i.reason))], issues: evidenced,
    agreementCleared: remaining.length - evidenced.length,
    readCount: reads.length }, reads, usage: totalUsage(reads) };
}
