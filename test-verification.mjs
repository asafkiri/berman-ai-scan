import test from 'node:test';
import assert from 'node:assert/strict';
import { compareScans, inspectScan, runVerifiedScan } from './scan-verification.js';
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
