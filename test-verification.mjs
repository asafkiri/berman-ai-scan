import test from 'node:test';
import assert from 'node:assert/strict';
import { compareScans, inspectScan, runVerifiedScan, escalationTriggers, docDateIso } from './scan-verification.js';
import { scanChecksumMismatches } from './server.js';

const documents = [{ noteIndex: 0, pages: ['original-photo'] }];
function paper() {
  return { warnings: [], documents: [{ noteIndex: 0, docNumber: '87654321', docType: 'invoice',
    docDate: '14/09/2026', pageCount: 1, totalUnits: 10, printedLines: 2,
    netToChargeExVat: 100, vatAmountPrinted: 18, totalToChargeInclVat: 118,
    confidence: .99, warnings: [], rows: [
      { sourcePage: 1, lineNumber: 5, itemCode: '1231', barcode: '498256', description: 'promo rolls', quantity: 8, unitPriceExVat: 8.5, confidence: .99 },
      { sourcePage: 1, lineNumber: 12, itemCode: '649', barcode: '4685447', description: 'spelt rolls', quantity: 2, unitPriceExVat: 14.94, confidence: .99 }
    ] }] };
}
function result(scan, model = 'luna') {
  return { scan, data: { model, id: 'id-' + model, usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } };
}
async function run(outputs, options = {}) {
  const calls = [];
  const output = await runVerifiedScan({ documents, checksum: scanChecksumMismatches,
    attemptScan: async (...args) => { calls.push(args); return outputs.shift(); }, ...options });
  return { ...output, calls };
}
test('both cheap reads start before either finishes; no previous answer enters the second read', async () => {
  const waiting = [], calls = [];
  const promise = runVerifiedScan({ documents, checksum: scanChecksumMismatches,
    attemptScan: (...args) => { calls.push(args); return new Promise(resolve => waiting.push(resolve)); } });
  assert.equal(waiting.length, 2);
  assert.ok(calls.every(call => call[2] === false));
  assert.ok(!JSON.stringify(calls).includes('14.94'));
  waiting.forEach(resolve => resolve(result(paper())));
  const value = await promise;
  assert.equal(value.verification.status, 'agreed');
  assert.equal(value.verification.readCount, 2);
  assert.equal(value.usage.total_tokens, 240);
});
test('14.84 versus 14.94 escalates even though quantities and the footer agree', async () => {
  const wrong = paper(); wrong.documents[0].rows[1].unitPriceExVat = 14.84;
  const value = await run([result(wrong), result(paper()), result(paper(), 'terra')]);
  assert.equal(value.calls.length, 3);
  assert.equal(value.calls[2][2], true);
  assert.equal(value.verification.status, 'verified');
  assert.equal(value.selected.scan.documents[0].rows[1].unitPriceExVat, 14.94);
  assert.ok(!value.calls[2][0].includes('14.84') && !value.calls[2][0].includes('14.94'));
  assert.match(value.calls[2][0], /שורה מודפסת 12/);
  assert.equal(value.usage.total_tokens, 360);
});
for (const field of ['itemCode', 'barcode', 'quantity', 'unitPriceExVat']) {
  test('a disputed row ' + field + ' triggers the stronger read', async () => {
    const wrong = paper(), row = wrong.documents[0].rows[1];
    row[field] = typeof row[field] === 'number' ? row[field] + 1 : row[field] + '1';
    const value = await run([result(wrong), result(paper()), result(paper(), 'terra')]);
    assert.equal(value.calls.length, 3);
    assert.equal(value.verification.status, 'verified');
  });
}
// בקשה בלי dateDefaults (אפליקציה 141 ומטה) — כמו v7, גם התאריך. עם dateDefaults — בלי התאריך (הבדיקות של v8 למטה).
for (const field of ['docNumber', 'docDate', 'docType', 'netToChargeExVat', 'totalUnits', 'printedLines', 'vatAmountPrinted', 'totalToChargeInclVat']) {
  test('a disputed document ' + field + ' triggers the stronger read', async () => {
    const wrong = paper(), doc = wrong.documents[0];
    doc[field] = typeof doc[field] === 'number' ? doc[field] + 1 : doc[field] === 'invoice' ? 'credit' : doc[field] + '1';
    const value = await run([result(wrong), result(paper()), result(paper(), 'terra')]);
    assert.equal(value.calls.length, 3);
    assert.equal(value.verification.status, 'verified');
  });
}
test('row order, descriptions, date formatting and trailing decimal zeroes are not disagreements', () => {
  const a = paper(), b = paper();
  b.documents[0].docDate = '2026-09-14';
  b.documents[0].rows.reverse(); b.documents[0].rows[0].description = 'different spacing';
  b.documents[0].rows[1].unitPriceExVat = 8.50;
  assert.deepEqual(compareScans(a, b), []);
});
test('duplicate products are preserved as separate rows', () => {
  const a = paper(), b = paper();
  a.documents[0].rows.push({ ...a.documents[0].rows[0], lineNumber: 6 });
  b.documents[0].rows.push({ ...b.documents[0].rows[0], lineNumber: 6, quantity: 9 });
  assert.ok(compareScans(a, b).some(i => i.lineNumber === 6 && i.field === 'quantity'));
});
test('two matching but internally inconsistent reads still escalate', async () => {
  const wrong = paper(); wrong.documents[0].netToChargeExVat = 100.2;
  const value = await run([result(wrong), result(wrong), result(paper(), 'terra')]);
  assert.equal(value.calls.length, 3);
  assert.equal(value.verification.status, 'verified');
});
test('missing price is not a successful agreement and never receives an invented value', async () => {
  const unknown = paper(); unknown.documents[0].rows[1].unitPriceExVat = null;
  const value = await run([result(unknown), result(unknown), result(unknown, 'terra')]);
  assert.equal(value.calls.length, 3);
  assert.equal(value.verification.status, 'needs_review');
  assert.equal(value.selected.scan.documents[0].rows[1].unitPriceExVat, null);
  assert.ok(value.verification.issues.some(i => i.rowIndex === 1 && i.field === 'unitPriceExVat'));
});
test('an optional missing barcode with a clear item code does not force escalation', () => {
  const a = paper(); a.documents[0].rows[0].barcode = null;
  assert.deepEqual(inspectScan(a, documents, scanChecksumMismatches), []);
});
test('failed stronger read keeps the disputed result explicitly pending', async () => {
  const wrong = paper(); wrong.documents[0].rows[1].unitPriceExVat = 14.84;
  const value = await run([result(wrong), result(paper()), { fail: { body: { error: 'openai_timeout' } } }]);
  assert.equal(value.calls.length, 3);
  assert.equal(value.verification.status, 'needs_review');
  assert.equal(value.selected.scan.documents[0].rows[1].unitPriceExVat, 14.84);
  assert.ok(value.verification.issues.some(i => i.field === 'unitPriceExVat'));
});
test('one failed cheap request does not discard the other; a fresh strong read verifies it', async () => {
  const value = await run([{ fail: { body: { error: 'invalid_model_output' } } }, result(paper()), result(paper(), 'terra')]);
  assert.equal(value.verification.status, 'verified');
  assert.equal(value.calls.length, 3);
});
test('price verification requested by the client uses only one strong read', async () => {
  const value = await run([result(paper(), 'terra')], { verificationOnly: true,
    targets: [{ noteIndex: 0, sourcePage: 1, lineNumber: 12, field: 'unitPriceExVat' }] });
  assert.equal(value.calls.length, 1);
  assert.equal(value.calls[0][2], true);
  assert.equal(value.verification.primaryReads, 0);
  assert.equal(value.verification.status, 'verified');
});
test('low-confidence evidence in either read requires verification', async () => {
  const a = paper(); a.documents[0].rows[0].confidence = .5;
  const value = await run([result(a), result(paper()), result(paper(), 'terra')]);
  assert.equal(value.calls.length, 3);
});
test('multiple documents compare their own rows and summaries', () => {
  const a = paper();
  a.documents.push({ ...structuredClone(a.documents[0]), noteIndex: 1, docType: 'credit' });
  const b = structuredClone(a); b.documents[1].rows[1].quantity = 3; b.documents.reverse();
  const issues = compareScans(a, b);
  assert.equal(issues.length, 1); assert.equal(issues[0].noteIndex, 1);
});

// ===== הסכמה תלת-כיוונית גוברת על ביטחון מדווח =====
// שלוש קריאות שתמללו את אותו תא זהה הן ראיה חזקה מדיווח עצמי של קריאה אחת.
// ההקלה חלה רק על low_confidence, ורק כששלוש הקריאות באמת מסכימות.
const lowRow = (scan, index = 0, value = .7) => { scan.documents[0].rows[index].confidence = value; return scan; };

test('three reads that agree character-for-character clear a low-confidence row', async () => {
  const value = await run([result(lowRow(paper())), result(paper()), result(lowRow(paper()), 'terra')]);
  assert.equal(value.calls.length, 3);
  assert.equal(value.verification.status, 'verified');
  assert.deepEqual(value.verification.issues, []);
  assert.equal(value.verification.agreementCleared, 1);
});
// המקרה שההקלה הנאיבית הייתה בולעת: הזוג הזול הסכים על 8.5, ההסלמה נפתחה מסיבה
// אחרת לגמרי, והקריאה החזקה — זו שנשמרת — קראה 3.5 בביטחון נמוך. ההסכמה שייכת
// למספר אחר, ולכן אסור לה לכסות על המספר הזה.
test('a strong read that drifts from the agreeing pair still stops on its own low confidence', async () => {
  const second = paper(); second.documents[0].docNumber = '87654399';
  const drifted = lowRow(paper()); drifted.documents[0].rows[0].unitPriceExVat = 3.5;
  const value = await run([result(paper()), result(second), result(drifted, 'terra')]);
  assert.equal(value.calls.length, 3);
  assert.equal(value.selected.scan.documents[0].rows[0].unitPriceExVat, 3.5);
  assert.equal(value.verification.status, 'needs_review');
  assert.deepEqual(value.verification.issues.map(i => i.field + '/' + i.reason), ['row/low_confidence']);
  assert.equal(value.verification.agreementCleared, 0);
});
test('agreement never clears a confidence below the floor', async () => {
  const value = await run([result(lowRow(paper(), 0, .4)), result(paper()), result(lowRow(paper(), 0, .4), 'terra')]);
  assert.equal(value.verification.status, 'needs_review');
  assert.deepEqual(value.verification.issues.map(i => i.field), ['row']);
});
test('agreement clears a low document confidence only when every summary field matches', async () => {
  const dim = () => { const s = paper(); s.documents[0].confidence = .7; return s; };
  const agreed = await run([result(dim()), result(paper()), result(dim(), 'terra')]);
  assert.equal(agreed.verification.status, 'verified');
  assert.deepEqual(agreed.verification.issues, []);
  const moved = dim(); moved.documents[0].docNumber = '87654322';
  const drifted = await run([result(dim()), result(paper()), result(moved, 'terra')]);
  assert.equal(drifted.verification.status, 'needs_review');
  assert.deepEqual(drifted.verification.issues.map(i => i.field), ['document']);
});
test('agreement never clears evidence: unreadable cells, totals and checksum still block', async () => {
  const broken = () => { const s = lowRow(paper()); s.documents[0].rows[0].quantity = 0; return s; };
  const value = await run([result(broken()), result(broken()), result(broken(), 'terra')]);
  assert.equal(value.verification.status, 'needs_review');
  const fields = value.verification.issues.map(i => i.field);
  assert.ok(fields.includes('quantity'), 'unreadable quantity must survive agreement');
  assert.ok(fields.includes('totalUnits'), 'the units checksum must survive agreement');
  assert.ok(!fields.includes('row'), 'the agreed self-report is the only thing cleared');
});
test('a failed verification read keeps full strictness — a pair alone clears nothing', async () => {
  const value = await run([result(lowRow(paper())), result(lowRow(paper())), { fail: { body: { error: 'boom' } } }]);
  assert.equal(value.verification.status, 'needs_review');
  assert.ok(value.verification.issues.some(i => i.reason === 'low_confidence'));
  assert.equal(value.verification.agreementCleared, 0);
});
test('duplicate product lines cannot borrow each other proof', async () => {
  const twice = () => { const s = paper(); const row = structuredClone(s.documents[0].rows[0]);
    row.lineNumber = 6; s.documents[0].rows.push(row); s.documents[0].totalUnits = 18;
    s.documents[0].printedLines = 3; return s; };
  const one = twice(); one.documents[0].rows[2].confidence = .7;
  const other = twice(); other.documents[0].rows[2].unitPriceExVat = 9.5;
  const value = await run([result(one), result(other), result(one, 'terra')]);
  assert.equal(value.verification.status, 'needs_review');
  assert.deepEqual(value.verification.issues.map(i => i.field), ['row']);
});

// ===== שורת פיקדון אינה פער כמויות =====
// הלקוח סופר יחידות בלי פיקדון, השרת ספר איתו — וכל תעודה עם בקבוקים נכשלה.
test('a deposit line no longer fires the units checksum on a correct read', () => {
  const scan = paper();
  scan.documents[0].rows.push({ sourcePage: 1, lineNumber: 13, itemCode: '900', barcode: '77',
    description: 'פיקדון · בקבוק', quantity: 6, unitPriceExVat: 1.2, confidence: .99 });
  scan.documents[0].printedLines = 3;
  assert.deepEqual(inspectScan(scan, documents, scanChecksumMismatches), []);
});
test('a real quantity misread is still caught on a note that has a deposit line', () => {
  const scan = paper();
  scan.documents[0].rows.push({ sourcePage: 1, lineNumber: 13, itemCode: '900', barcode: '77',
    description: 'פיקדון · בקבוק', quantity: 6, unitPriceExVat: 1.2, confidence: .99 });
  scan.documents[0].printedLines = 3;
  scan.documents[0].rows[0].quantity = 6;
  assert.deepEqual(inspectScan(scan, documents, scanChecksumMismatches).map(i => i.field), ['totalUnits']);
});

// ===== v6: מה הפעיל את הקריאה השלישית =====
// התשובה שומרת את הסוגיות שגרמו לקריאה החזקה (בתשלום), ולא רק את מה שנשאר פתוח
// אחריה. moneyOnly מסמן קריאה שהפעילו רק שדות כסף — המחיר המודפס, נטו, מע"מ,
// סה"כ — שהלקוח כבר אינו משתמש בהם להכרעה.
test('a price-only disagreement records the price field as the trigger and marks it money-only', async () => {
  const wrong = paper(); wrong.documents[0].rows[1].unitPriceExVat = 14.84;
  const value = await run([result(wrong), result(paper()), result(paper(), 'terra')]);
  assert.deepEqual(value.verification.triggers, [{ noteIndex: 0, field: 'unitPriceExVat', reason: 'disagreement', rowIndex: 1, sourcePage: 1, lineNumber: 12 }]);
  assert.deepEqual(value.verification.triggerSummary, { 'disagreement:unitPriceExVat': 1 });
  assert.equal(value.verification.moneyOnly, true);
  assert.equal(value.verification.triggersTruncated, false);
  assert.deepEqual(value.verification.issues, [], 'issues is still only what is open after the read');
});
test('a code disagreement, or a low-confidence row, is not money-only', async () => {
  const code = paper(); code.documents[0].rows[0].itemCode = '1232';
  const a = await run([result(code), result(paper()), result(paper(), 'terra')]);
  assert.deepEqual(a.verification.triggerSummary, { 'disagreement:itemCode': 1 });
  assert.equal(a.verification.moneyOnly, false);
  const low = paper(); low.documents[0].rows[0].confidence = .5;
  const b = await run([result(low), result(paper()), result(paper(), 'terra')]);
  assert.deepEqual(b.verification.triggerSummary, { 'low_confidence:row': 1 });
  assert.equal(b.verification.moneyOnly, false);
  const both = paper(); both.documents[0].rows[1].unitPriceExVat = 14.84; both.documents[0].rows[0].quantity = 9; both.documents[0].totalUnits = 11;
  const c = await run([result(both), result(paper()), result(paper(), 'terra')]);
  assert.equal(c.verification.moneyOnly, false, 'a price plus a quantity is not money-only');
  assert.equal(c.verification.triggerSummary['disagreement:unitPriceExVat'], 1);
  assert.equal(c.verification.triggerSummary['disagreement:quantity'], 1);
});
test('two agreeing cheap reads record no triggers', async () => {
  const value = await run([result(paper()), result(paper())]);
  assert.equal(value.verification.escalationAttempted, false);
  assert.ok(!('triggers' in value.verification) && !('moneyOnly' in value.verification));
});
test('a client-requested verification records its targets as the trigger', async () => {
  const value = await run([result(paper(), 'terra')], { verificationOnly: true,
    targets: [{ noteIndex: 0, sourcePage: 1, lineNumber: 12, field: 'itemCode' },
      { noteIndex: 0, sourcePage: 1, lineNumber: 13, field: 'quantity', reason: 'disagreement', rowIndex: 4 }] });
  assert.deepEqual(value.verification.triggers, [
    { noteIndex: 0, field: 'itemCode', reason: 'client_request', sourcePage: 1, lineNumber: 12 },
    { noteIndex: 0, field: 'quantity', reason: 'client_request', sourcePage: 1, lineNumber: 13 }], 'the client cannot relabel or add fields');
  assert.deepEqual(value.verification.triggerSummary, { 'client_request:itemCode': 1, 'client_request:quantity': 1 });
  assert.equal(value.verification.moneyOnly, false);
});
test('the trigger list is capped, but the summary counts every distinct trigger', () => {
  const issues = Array.from({ length: 75 }, (_, i) => ({ noteIndex: 0, field: 'unitPriceExVat', reason: 'disagreement', rowIndex: i }));
  issues.push(issues[0]);
  const out = escalationTriggers(issues);
  assert.equal(out.triggers.length, 60);
  assert.equal(out.triggersTruncated, true);
  assert.deepEqual(out.triggerSummary, { 'disagreement:unitPriceExVat': 75 }, 'duplicates count once');
  assert.equal(out.moneyOnly, true);
  assert.deepEqual(escalationTriggers([]), { triggers: [], triggerSummary: {}, moneyOnly: false, triggersTruncated: false });
});
test('v7: two cheap reads that agree the photo is not a driver strip do not pay for a stronger read', async () => {
  const a4 = () => ({ warnings: [], documents: [{ noteIndex: 0, docNumber: null, docType: 'unknown', docDate: null, pageCount: 1,
    totalUnits: null, printedLines: null, netToChargeExVat: null, vatAmountPrinted: null, totalToChargeInclVat: null,
    notDriverStrip: true, confidence: .9, warnings: [], rows: [] }] });
  const value = await run([result(a4()), result(a4())]);
  assert.equal(value.calls.length, 2);
  assert.equal(value.verification.escalationAttempted, false);
  assert.equal(value.verification.notDriverStrip, true);
  assert.equal(value.verification.status, 'needs_review');
  const strip = paper(); strip.documents[0].notDriverStrip = false;
  const normal = await run([result(strip), result(strip)]);
  assert.equal(normal.verification.status, 'agreed');
  assert.ok(!('notDriverStrip' in normal.verification));
});
test('v7: the A4 skip needs both reads, and every document of the request, to be an empty non-strip page', async () => {
  const a4doc = (noteIndex = 0) => ({ noteIndex, docNumber: null, docType: 'unknown', docDate: null, pageCount: 1, totalUnits: null, printedLines: null,
    netToChargeExVat: null, vatAmountPrinted: null, totalToChargeInclVat: null, notDriverStrip: true, confidence: .9, warnings: [], rows: [] });
  // one cheap read failed: a single "not a strip" read is not enough to skip the paid read
  const failed = await run([{ fail: { status: 502, body: { ok: false, error: 'invalid_model_output' } } }, result({ warnings: [], documents: [a4doc()] }), result(paper(), 'terra')]);
  assert.equal(failed.calls.length, 3);
  assert.ok(!('notDriverStrip' in failed.verification));
  // a two-document request: one A4 page and one strip — the strip still gets its paid read when disputed
  const strip = paper().documents[0], other = { ...strip, noteIndex: 1, rows: strip.rows.map(r => ({ ...r, quantity: r.quantity + 1 })) };
  const docs2 = [{ noteIndex: 0, pages: ['a'] }, { noteIndex: 1, pages: ['b'] }];
  const two = await runVerifiedScan({ documents: docs2, checksum: scanChecksumMismatches,
    attemptScan: (() => { const outs = [result({ warnings: [], documents: [a4doc(0), { ...strip, noteIndex: 1 }] }), result({ warnings: [], documents: [a4doc(0), other] }),
      result({ warnings: [], documents: [a4doc(0), { ...strip, noteIndex: 1 }] }, 'terra')]; return async () => outs.shift(); })() });
  assert.equal(two.reads.length, 3);
  assert.ok(!two.verification.notDriverStrip);
});
test('v7: the skip conditions are each required (flag, unknown, no rows, both reads)', async () => {
  const a4doc = o => ({ noteIndex: 0, docNumber: null, docType: 'unknown', docDate: null, pageCount: 1, totalUnits: null, printedLines: null,
    netToChargeExVat: null, vatAmountPrinted: null, totalToChargeInclVat: null, notDriverStrip: true, confidence: .9, warnings: [], rows: [], ...o });
  const pair = (a, b) => [result({ warnings: [], documents: [a] }), result({ warnings: [], documents: [b] }), result(paper(), 'terra')];
  const row = paper().documents[0].rows[0];
  // flagged + unknown + rows that disagree → the stronger read runs
  let v = await run(pair(a4doc({ rows: [row] }), a4doc({ rows: [{ ...row, quantity: row.quantity + 1 }] })));
  assert.equal(v.calls.length, 3, 'rows present');
  // flagged + invoice + 0 rows → the stronger read runs
  v = await run(pair(a4doc({ docType: 'invoice' }), a4doc({ docType: 'invoice' })));
  assert.equal(v.calls.length, 3, 'docType invoice');
  // unknown + 0 rows but no flag → the stronger read runs
  v = await run(pair(a4doc({ notDriverStrip: undefined }), a4doc({ notDriverStrip: undefined })));
  assert.equal(v.calls.length, 3, 'flag missing');
  // an honest A4 pair that disagrees on docDate still reports it, once (a request without dateDefaults — v7's checks)
  v = await run(pair(a4doc({ docDate: '01/10/2026' }), a4doc({ docDate: '02/10/2026' })));
  assert.equal(v.calls.length, 2);
  assert.ok(v.verification.issues.some(i => i.field === 'docDate' && i.reason === 'disagreement'));
  let keys = v.verification.issues.map(i => JSON.stringify(i));
  assert.equal(new Set(keys).size, keys.length, 'no duplicated issues');
  // v8 with dateDefaults: a date difference is no longer an issue — it is reported in
  // docDateUnreliable instead, so the disagreement here is the docNumber.
  v = await run(pair(a4doc({ docNumber: '1001', docDate: '01/10/2026' }), a4doc({ docNumber: '1002', docDate: '02/10/2026' })), { dateDefaults: true });
  assert.equal(v.calls.length, 2);
  assert.ok(v.verification.issues.some(i => i.field === 'docNumber' && i.reason === 'disagreement'));
  assert.ok(!v.verification.issues.some(i => i.field === 'docDate'));
  assert.deepEqual(v.verification.docDateUnreliable, [{ noteIndex: 0, reason: 'disputed' }]);
  keys = v.verification.issues.map(i => JSON.stringify(i));
  assert.equal(new Set(keys).size, keys.length, 'no duplicated issues');
});

// ===== v8: תאריך שלא נקרא היטב — לא עולה כסף ולא עוצר =====
// החלטת הבעלים: תאריך שלא נקרא היטב — ברירת המחדל היא יום הקליטה (בלקוח). לכן התאריך
// כבר אינו מפעיל קריאה שלישית בתשלום ואינו משאיר needs_review; השרת רק מדווח, לכל
// מסמך, אם התאריך הסופי לא נקרא ('unreadable') או שקריאה אחרת קראה תאריך אחר ואף אחת
// לא אישרה אותו ('disputed'). הערך המודפס עצמו לא משתנה.
const dated = (date, scan = paper()) => { scan.documents[0].docDate = date; return scan; };
// אפליקציה 142 ומעלה שולחת dateDefaults: true — רק לה התאריך יוצא מהבדיקה
const DD = { dateDefaults: true };
const run8 = (outputs, options = {}) => run(outputs, { ...DD, ...options });

test('v8: docDateIso reads the printed day the way the client does, and rejects what is not a calendar date', () => {
  assert.equal(docDateIso('14/09/2026'), '2026-09-14');
  assert.equal(docDateIso(' 14.9.26 '), '2026-09-14');
  assert.equal(docDateIso('2026-09-14'), '2026-09-14');
  assert.equal(docDateIso('4-10-2026'), '2026-10-04');
  for (const bad of [null, undefined, '', 'לא ברור', '31/02/2026', '14/13/2026', '2026-9-14', '14/09']) {
    assert.equal(docDateIso(bad), null, String(bad));
  }
});
test('v8: the date is neither compared nor required by the issue checks', () => {
  assert.deepEqual(compareScans(paper(), dated('15/09/2026'), DD), []);
  assert.deepEqual(compareScans(paper(), dated(null), DD), []);
  assert.deepEqual(inspectScan(dated(null), documents, scanChecksumMismatches, DD), []);
  assert.deepEqual(inspectScan(dated('לא ברור'), documents, scanChecksumMismatches, DD), []);
});
test('v8: a date-only difference between the cheap reads costs two calls, stays agreed, and flags the date', async () => {
  const value = await run8([result(paper()), result(dated('15/09/2026'))]);
  assert.equal(value.calls.length, 2);
  assert.equal(value.verification.escalationAttempted, false);
  assert.equal(value.verification.status, 'agreed');
  assert.deepEqual(value.verification.issues, []);
  assert.ok(!('triggers' in value.verification));
  assert.deepEqual(value.verification.docDateUnreliable, [{ noteIndex: 0, reason: 'disputed' }]);
  assert.equal(value.selected.scan.documents[0].docDate, '14/09/2026', 'the printed value is returned as read');
});
test('v8: two reads of the same day in different formats confirm it', async () => {
  const value = await run8([result(dated('14/09/26')), result(dated('2026-09-14'))]);
  assert.equal(value.calls.length, 2);
  assert.equal(value.verification.status, 'agreed');
  assert.deepEqual(value.verification.docDateUnreliable, []);
});
for (const date of [null, '', 'לא ברור', '31/02/2026']) {
  test('v8: an unread date alone (' + JSON.stringify(date) + ') does not pay for the stronger read', async () => {
    const value = await run8([result(dated(date)), result(dated(date))]);
    assert.equal(value.calls.length, 2);
    assert.equal(value.verification.escalationAttempted, false);
    assert.equal(value.verification.status, 'agreed');
    assert.deepEqual(value.verification.issues, []);
    assert.deepEqual(value.verification.docDateUnreliable, [{ noteIndex: 0, reason: 'unreadable' }]);
  });
}
test('v8: a read without a date neither confirms nor disputes; only the final read decides unreadable', async () => {
  const firstRead = await run8([result(paper()), result(dated(null))]);
  assert.equal(firstRead.calls.length, 2);
  assert.equal(firstRead.verification.status, 'agreed');
  assert.deepEqual(firstRead.verification.docDateUnreliable, [], 'the other read saw no date, so nothing disputes it');
  assert.deepEqual(firstRead.verification.docDateRead, [], 'the final read has its own date');
  // the same evidence with the reads swapped: the final read has no date and the other read 14/09 —
  // nothing disputes that day, so it is not "unreadable"; it is reported apart (docDateRead),
  // and the printed value of the final read stays as read
  const missing = await run8([result(dated(null)), result(paper())]);
  assert.equal(missing.calls.length, 2);
  assert.equal(missing.verification.status, 'agreed');
  assert.deepEqual(missing.verification.docDateUnreliable, []);
  assert.deepEqual(missing.verification.docDateRead, [{ noteIndex: 0, day: '2026-09-14' }]);
  assert.equal(missing.selected.scan.documents[0].docDate, null, 'no date is borrowed into the scan from the other read');
});
test('v8: the final read has no date — another read\'s day is reported only when the other reads read exactly one day', async () => {
  const price = date => { const s = dated(date); s.documents[0].rows[1].unitPriceExVat = 14.84; return s; };
  // two other reads, two different days — nothing to carry: unreadable, as before
  const split = await run8([result(price('14/09/2026')), result(dated('15/09/2026')), result(dated(null), 'terra')]);
  assert.equal(split.calls.length, 3);
  assert.deepEqual(split.verification.docDateUnreliable, [{ noteIndex: 0, reason: 'unreadable' }]);
  assert.deepEqual(split.verification.docDateRead, []);
  // the same day in two formats is one day
  const same = await run8([result(price('14/09/26')), result(dated('2026-09-14')), result(dated(null), 'terra')]);
  assert.deepEqual(same.verification.docDateUnreliable, []);
  assert.deepEqual(same.verification.docDateRead, [{ noteIndex: 0, day: '2026-09-14' }]);
  // a text or 31/02 in another read is not a day
  const junk = await run8([result(dated(null)), result(dated('31/02/2026'))]);
  assert.deepEqual(junk.verification.docDateUnreliable, [{ noteIndex: 0, reason: 'unreadable' }]);
  assert.deepEqual(junk.verification.docDateRead, []);
  // without dateDefaults (app 141) the date is still checked as in v7: a missing date pays for the stronger
  // read and stays needs_review when that read misses it too — the extra field changes nothing there
  const legacy = await run([result(dated(null)), result(paper()), result(dated(null), 'terra')]);
  assert.equal(legacy.calls.length, 3);
  assert.equal(legacy.verification.status, 'needs_review');
  assert.ok(legacy.verification.issues.some(i => i.field === 'docDate'));
});
test('v8: when the stronger read ran for another reason, its date is still checked against the cheap pair', async () => {
  const price = date => { const s = dated(date); s.documents[0].rows[1].unitPriceExVat = 14.84; return s; };
  // the pair disagreed on the date as well; the stronger read agrees with one of them
  const confirmed = await run8([result(price('14/09/2026')), result(dated('15/09/2026')), result(paper(), 'terra')]);
  assert.equal(confirmed.calls.length, 3);
  assert.equal(confirmed.verification.status, 'verified');
  assert.deepEqual(confirmed.verification.triggerSummary, { 'disagreement:unitPriceExVat': 1 }, 'the date is not a trigger');
  assert.ok(!confirmed.calls[2][0].includes('תאריך התעודה'), 'the stronger read is not asked about the date');
  assert.deepEqual(confirmed.verification.docDateUnreliable, []);
  // both cheap reads read one day, the stronger read — whose scan is kept — another
  const disputed = await run8([result(price('15/09/2026')), result(dated('15/09/2026')), result(paper(), 'terra')]);
  assert.equal(disputed.verification.status, 'verified', 'the date alone never makes needs_review');
  assert.equal(disputed.selected.scan.documents[0].docDate, '14/09/2026');
  assert.deepEqual(disputed.verification.docDateUnreliable, [{ noteIndex: 0, reason: 'disputed' }]);
  // the stronger read could not read the date; both cheap reads read 14/09 — that day is carried apart
  // (docDateRead), the stronger read's printed value stays null
  const unread = await run8([result(price('14/09/2026')), result(paper()), result(dated(null), 'terra')]);
  assert.equal(unread.verification.status, 'verified');
  assert.deepEqual(unread.verification.issues, []);
  assert.deepEqual(unread.verification.docDateUnreliable, []);
  assert.deepEqual(unread.verification.docDateRead, [{ noteIndex: 0, day: '2026-09-14' }]);
  assert.equal(unread.selected.scan.documents[0].docDate, null);
  // no read read a date at all — unreadable
  const none = await run8([result(price(null)), result(dated(null)), result(dated(null), 'terra')]);
  assert.deepEqual(none.verification.docDateUnreliable, [{ noteIndex: 0, reason: 'unreadable' }]);
  assert.deepEqual(none.verification.docDateRead, []);
});
test('v8: a failed stronger read keeps its other issues but never adds the date to them', async () => {
  const wrong = dated('15/09/2026'); wrong.documents[0].rows[1].unitPriceExVat = 14.84;
  const value = await run8([result(wrong), result(paper()), { fail: { body: { error: 'openai_timeout' } } }]);
  assert.equal(value.calls.length, 3);
  assert.equal(value.verification.status, 'needs_review');
  assert.ok(value.verification.issues.some(i => i.field === 'unitPriceExVat'));
  assert.ok(!value.verification.issues.some(i => i.field === 'docDate'));
  assert.deepEqual(value.verification.docDateUnreliable, [{ noteIndex: 0, reason: 'disputed' }]);
});
test('v8: a date difference does not keep a low document confidence open when three reads agree on the rest', async () => {
  const dim = date => { const s = dated(date); s.documents[0].confidence = .7; return s; };
  const value = await run8([result(dim('14/09/2026')), result(paper()), result(dim('15/09/2026'), 'terra')]);
  assert.equal(value.calls.length, 3);
  assert.equal(value.verification.status, 'verified');
  assert.deepEqual(value.verification.issues, []);
  assert.equal(value.verification.agreementCleared, 1);
  assert.deepEqual(value.verification.docDateUnreliable, [{ noteIndex: 0, reason: 'disputed' }]);
});
test('v8: a client-requested verification has one read — only an unread date can be flagged', async () => {
  const targets = [{ noteIndex: 0, sourcePage: 1, lineNumber: 12, field: 'itemCode' }];
  const read = await run8([result(paper(), 'terra')], { verificationOnly: true, targets });
  assert.deepEqual(read.verification.docDateUnreliable, []);
  const unread = await run8([result(dated(null), 'terra')], { verificationOnly: true, targets });
  assert.equal(unread.calls.length, 1);
  assert.equal(unread.verification.status, 'verified');
  assert.deepEqual(unread.verification.docDateUnreliable, [{ noteIndex: 0, reason: 'unreadable' }]);
  assert.deepEqual(unread.verification.docDateRead, [], 'one read — no other read to carry a day from');
});
// שומר: רק התאריך יצא מהבדיקה — כל שדה סיכום אחר שלא נקרא עדיין משלם על הקריאה החזקה.
for (const field of ['docNumber', 'totalUnits', 'printedLines', 'netToChargeExVat']) {
  test('v8: an unread ' + field + ' in both reads still triggers the stronger read', async () => {
    const blank = () => { const s = paper(); s.documents[0][field] = null; return s; };
    const value = await run8([result(blank()), result(blank()), result(paper(), 'terra')]);
    assert.equal(value.calls.length, 3);
    assert.equal(value.verification.triggerSummary['unreadable:' + field], 1);
    assert.equal(value.verification.status, 'verified');
  });
}
test('v8: the date is judged per document', async () => {
  const two = date => { const s = paper(); s.documents.push({ ...structuredClone(s.documents[0]), noteIndex: 1, docDate: date }); return s; };
  const docs2 = [{ noteIndex: 0, pages: ['a'] }, { noteIndex: 1, pages: ['b'] }];
  const outs = [result(two('14/09/2026')), result(two('16/09/2026'))];
  const value = await runVerifiedScan({ documents: docs2, checksum: scanChecksumMismatches, attemptScan: async () => outs.shift(), dateDefaults: true });
  assert.equal(value.reads.length, 2);
  assert.equal(value.verification.status, 'agreed');
  assert.deepEqual(value.verification.docDateUnreliable, [{ noteIndex: 1, reason: 'disputed' }]);
});

// ===== v8 בלי dateDefaults (אפליקציה 141 ומטה) — בדיקת התאריך של v7, בלי שינוי =====
// אפליקציה 141 לא קוראת את docDateUnreliable: אילו v8 היה מוותר גם לה על בדיקת התאריך, תאריך במחלוקת
// היה עובר אצלה בשקט (התאריך של הקריאה הזולה הראשונה, ובתעודת משלוח מהשבוע האחרון — יום הקליטה).
// לכן רק בקשה שאומרת dateDefaults: true מקבלת את כללי v8; כל בקשה אחרת — כמו v7. סדר הפריסה לא משנה.
test('v8 without dateDefaults: a date-only difference still pays for the stronger read, which settles the date (as v7)', async () => {
  const value = await run([result(paper()), result(dated('15/09/2026')), result(paper(), 'terra')]);
  assert.equal(value.calls.length, 3);
  assert.equal(value.verification.escalationAttempted, true);
  assert.deepEqual(value.verification.triggerSummary, { 'disagreement:docDate': 1 });
  assert.match(value.calls[2][0], /תאריך התעודה/, 'the stronger read is asked about the date, as in v7');
  assert.equal(value.verification.status, 'verified');
  assert.equal(value.verification.dateDefaults, false);
  assert.deepEqual(value.verification.docDateUnreliable, [], 'the stronger read is confirmed by one of the cheap reads');
});
test('v8 without dateDefaults: an unread date pays for the stronger read and stays needs_review when that read cannot read it either', async () => {
  const value = await run([result(dated(null)), result(dated(null)), result(dated(null), 'terra')]);
  assert.equal(value.calls.length, 3);
  assert.equal(value.verification.triggerSummary['unreadable:docDate'], 1, 'one trigger (the same issue from both reads)');
  assert.equal(value.verification.status, 'needs_review');
  assert.ok(value.verification.issues.some(i => i.field === 'docDate' && i.reason === 'unreadable'));
  assert.deepEqual(value.verification.docDateUnreliable, [{ noteIndex: 0, reason: 'unreadable' }]);
  // a client-requested verification without the flag — the unread date keeps it in needs_review (as v7)
  const targets = [{ noteIndex: 0, sourcePage: 1, lineNumber: 12, field: 'itemCode' }];
  const verify = await run([result(dated(null), 'terra')], { verificationOnly: true, targets });
  assert.equal(verify.verification.status, 'needs_review');
  assert.ok(verify.verification.issues.some(i => i.field === 'docDate'));
});
test('v8 without dateDefaults: the exported checks default to v7 (date compared and required); only true switches them', async () => {
  assert.deepEqual(compareScans(paper(), dated('15/09/2026')).map(i => i.field), ['docDate']);
  assert.deepEqual(inspectScan(dated(null), documents, scanChecksumMismatches).map(i => i.field), ['docDate']);
  assert.deepEqual(compareScans(paper(), dated('2026-09-14')), [], 'the same day in another format is not a disagreement');
  for (const flag of [undefined, false, 'true', 1]) {
    const value = await run([result(paper()), result(dated('15/09/2026')), result(paper(), 'terra')], { dateDefaults: flag });
    assert.equal(value.calls.length, 3, String(flag));
  }
  const dim = date => { const s = dated(date); s.documents[0].confidence = .7; return s; };
  // a low document confidence is cleared by three reads only when they agree on the date too (v7)
  const value = await run([result(dim('14/09/2026')), result(paper()), result(dim('15/09/2026'), 'terra')]);
  assert.equal(value.verification.status, 'needs_review');
  assert.ok(value.verification.issues.some(i => i.field === 'document' && i.reason === 'low_confidence'));
});
