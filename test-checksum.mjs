// בדיקות ל-scanChecksumMismatches — עוגן הביקורת של הקריאה.
// הרצה: node test-checksum.mjs
//
// v62 שינה כאן דבר אחד: מסמך שלא הוקלד לו עוגן (זרימת הצילום-תחילה בלקוח)
// כבר אינו מדלג על הבדיקה, אלא נמדד מול בלוק הסיכום שמודפס בתחתית אותו
// נייר. הבדיקות מוודאות גם שההתנהגות הישנה — עם עוגן מוקלד — לא זזה.
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { scanChecksumMismatches, validModelScan, normalizePaperFields, createServer } from "./server.js";

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ""}`); }
}
function section(title) { console.log(`\n${title}`); }

// Match the real model schema: it has unitPriceExVat, never lineTotalExVat.
function row(quantity, unitPriceExVat) {
  return { sourcePage: 1, lineNumber: null, barcode: null, itemCode: String(100 + quantity),
    description: "test bread", quantity, unitPriceExVat, confidence: 1 };
}
// תעודה כפי שהמודל מחזיר אותה, עם בלוק סיכום שמסכים עם השורות
function doc(rows, overrides) {
  const units = rows.reduce((sum, item) => sum + item.quantity, 0);
  return Object.assign({
    noteIndex: 0, rows, totalUnits: units, printedLines: rows.length, netToChargeExVat: 457.45,
    docNumber: "123456", docType: "invoice", docDate: "07/09/2026", pageCount: 1,
    vatAmountPrinted: 82.34, totalToChargeInclVat: 539.79, confidence: 1, warnings: [],
  }, overrides || {});
}
const ROWS = [row(30, 6.24), row(13, 8.50), row(7, 17.21), row(15, 4.1), row(6, 12.8)];
const scan = document => ({ documents: [document], warnings: [] });
const typed = (expectedUnits, expectedLines) => [{ noteIndex: 0, expectedUnits, expectedLines }];
const noAnchor = [{ noteIndex: 0, expectedUnits: null, expectedLines: null }];

section("[1] עוגן מוקלד — ההתנהגות הישנה לא זזה");
check("קריאה שנסגרת על העוגן אינה מייצרת ממצא",
  scanChecksumMismatches(scan(doc(ROWS)), typed(71, 5)).length === 0);
const typedOff = scanChecksumMismatches(scan(doc(ROWS)), typed(70, 5));
check("עוגן שונה מהקריאה מייצר ממצא", typedOff.length === 1 && typedOff[0].unitsOff === true);
check("והוא מסומן כחשד להקלדה שגויה", typedOff[0].typedAnchorSuspect === true);
check("בדיקת הכסף כבויה במצב עוגן מוקלד", typedOff[0].moneyOff === false);

section("[2] בלי עוגן — קריאה שנסגרת מול הנייר");
check("אין ממצא, ולכן אין קריאה חוזרת מיותרת",
  scanChecksumMismatches(scan(doc(ROWS)), noAnchor).length === 0);

section("[3] בלי עוגן — כמות שנקראה שגוי");
const badQty = doc(ROWS);
badQty.rows = [row(20, 6.24)].concat(ROWS.slice(1)); // 30 נקרא כ-20
const m3 = scanChecksumMismatches(scan(badQty), noAnchor);
check("נוצר ממצא (לפני v62 זה עבר בשקט)", m3.length === 1);
check("מסומן שההשוואה היא מול הנייר", m3[0].fromPaper === true);
check("בדיקת היחידות נפלה", m3[0].unitsOff === true);
check("ההשוואה היא מול המודפס", m3[0].expectedUnits === 71 && m3[0].gotUnits === 61, JSON.stringify(m3[0]));
check("אין חשד להקלדה — לא הוקלד דבר", m3[0].typedAnchorSuspect === false);

section("[4] בלי עוגן — שורה שפוספסה");
const missingRow = doc(ROWS);
missingRow.rows = ROWS.slice(0, 4); // בלוק הסיכום עדיין מכריז על 5 שורות ו-71 יח׳
const m4 = scanChecksumMismatches(scan(missingRow), noAnchor);
check("בדיקת השורות נפלה", m4.length === 1 && m4[0].linesOff === true);

section("[5] כסף נבדק בלקוח שמכיר את המחירים והמבצעים");
check("הפענוח תואם לסכימת המודל האמיתית",
  validModelScan(scan(doc(ROWS)), [{ noteIndex: 0, pages: ["image"] }]));
check("אין שדה סכום שורה בסריקה", ROWS.every(r => !("lineTotalExVat" in r)));
const differentNet = doc(ROWS, { netToChargeExVat: 450 });
check("השרת אינו מסיק כסף מהמחירון או מאפס — האימות הכספי נשאר בלקוח",
  scanChecksumMismatches(scan(differentNet), noAnchor).length === 0);
const regularRows = ROWS.map((r, i) => i === 1 ? { ...r, unitPriceExVat: 20.46 } : { ...r });
check("גם מחירון במקום מחיר המבצע אינו מפעיל קריאה חוזרת",
  scanChecksumMismatches(scan(doc(regularRows)), noAnchor).length === 0);

section("[6] בלי עוגן — צילום שנקטע לפני בלוק הסיכום");
const cutOff = doc(ROWS, { totalUnits: null, printedLines: null, netToChargeExVat: null });
const m6 = scanChecksumMismatches(scan(cutOff), noAnchor);
check("נוצר ממצא במקום דילוג שקט", m6.length === 1);
check("מסומן summaryBlockMissing — הקורא מוותר מיד", m6[0].summaryBlockMissing === true);
check("בלי unitsOff/linesOff מדומים", m6[0].unitsOff === false && m6[0].linesOff === false);

section("[7] בלי עוגן — בלוק סיכום חלקי");
const partial = doc(ROWS, { totalUnits: null }); // שורות ונטו נקראו, יחידות לא
const m7 = scanChecksumMismatches(scan(partial), noAnchor);
check("מה שנקרא עדיין נבדק, ואין ממצא כשהכול נסגר", m7.length === 0);
const partialBad = doc(ROWS, { totalUnits: null });
partialBad.rows = ROWS.slice(0, 4);
const m7b = scanChecksumMismatches(scan(partialBad), noAnchor);
check("ושורה חסרה נתפסת גם בלי שדה היחידות", m7b.length === 1 && m7b[0].linesOff === true);

section("[8] מסמך בלי קלט תואם");
check("מדולג בלי לקרוס", scanChecksumMismatches(scan(doc(ROWS)), []).length === 0);

section("[9] v7 — כותרת, מספרי בקרה ונייר שאינו של המסופון");
// נייר החיוב הקצר 290095141 כפי שצולם (4.10, 09:03): שתי שורות, 15 יח׳, ביקורת 111
const paper141 = () => ({ noteIndex: 0, docNumber: "290095141", docType: "invoice", docDate: "04/10/2026", pageCount: 1,
  totalUnits: 15, printedLines: 2, netToChargeExVat: 90.45, vatAmountPrinted: 16.28, totalToChargeInclVat: 106.73,
  headerText: "ת.משלוח", internalNumber: null, numerator: "95141", printedCheck: 111,
  otherPapersVisible: false, notDriverStrip: false, confidence: 0.97, warnings: [], rows: [
    { sourcePage: 1, lineNumber: 1, barcode: "498355", itemCode: "100", description: "לחם אחיד ברמן", quantity: 13, unitPriceExVat: 5.65, confidence: 0.97 },
    { sourcePage: 1, lineNumber: 2, barcode: "498256", itemCode: "1231", description: "לחמניות 10 בשק", quantity: 2, unitPriceExVat: 8.5, confidence: 0.97 }] });
const a4 = () => ({ noteIndex: 0, docNumber: null, docType: "unknown", docDate: null, pageCount: 1,
  totalUnits: null, printedLines: null, netToChargeExVat: null, vatAmountPrinted: null, totalToChargeInclVat: null,
  headerText: null, internalNumber: null, numerator: null, printedCheck: null,
  otherPapersVisible: false, notDriverStrip: true, confidence: 0.9, warnings: ["זה אינו סרט מסופון"], rows: [] });
const oneInput = [{ noteIndex: 0, pages: ["image"] }];
check("נייר קצר עם שדות v7 עובר את אימות המבנה", validModelScan(scan(paper141()), oneInput));
check("ושורות הנייר נסגרות מול בלוק הסיכום שלו", scanChecksumMismatches(scan(paper141()), noAnchor).length === 0);
check("מספר פנימי עם האות N נדחה כשאינו מנוקה (רק ספרות)", !validModelScan(scan({ ...paper141(), internalNumber: "N290095159" }), oneInput));
const messy = scan({ ...paper141(), internalNumber: "N 290095159\u200f", numerator: "95141.00", headerText: 5, printedCheck: "147" });
normalizePaperFields(messy);
check("v7: הניקוי מסיר N, רווחים וסימני כיוון — והקריאה נשארת תקינה",
  messy.documents[0].internalNumber === "290095159" && messy.documents[0].numerator === "95141" && messy.documents[0].headerText === null
  && messy.documents[0].printedCheck === 147 && validModelScan(messy, oneInput), JSON.stringify(messy.documents[0]));
const garbage = scan({ ...paper141(), internalNumber: "לא ברור", numerator: "" });
normalizePaperFields(garbage);
const oddCheck = scan({ ...paper141(), printedCheck: { valueOf: 1, toString: 1 } });
normalizePaperFields(oddCheck);
const blankCheck = scan({ ...paper141(), printedCheck: " " });
normalizePaperFields(blankCheck);
check("v7: ביקורת בצורה משונה (אובייקט, רווח) הופכת ל-null ולא מפילה את השרת",
  oddCheck.documents[0].printedCheck === null && blankCheck.documents[0].printedCheck === null);
check("v7: מספר שאינו ספרות הופך ל-null עם אזהרה, לא מפיל את הקריאה",
  garbage.documents[0].internalNumber === null && garbage.documents[0].numerator === null
  && garbage.documents[0].warnings.some(w => w.includes("internalNumber")) && validModelScan(garbage, oneInput));
check("ביקורת שאינה מספר שלם נדחית", !validModelScan(scan({ ...paper141(), printedCheck: 111.5 }), oneInput));
check("דגל שאינו בוליאני נדחה", !validModelScan(scan({ ...paper141(), otherPapersVisible: "no" }), oneInput)
  && !validModelScan(scan({ ...paper141(), notDriverStrip: null }), oneInput));
check("דף A4 בלי שורות הוא פלט תקין", validModelScan(scan(a4()), oneInput));

section("[10] מסלול הבקשה המלא בזיכרון — בלי פתיחת חיבור רשת");
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "local-test" };
const seconds = Math.floor(Date.now() / 1000);
const encode = obj => Buffer.from(JSON.stringify(obj)).toString("base64url");
const unsigned = encode({ alg: "RS256", kid: jwk.kid }) + "." + encode({
  aud: "berman-marketkiri", iss: "https://securetoken.google.com/berman-marketkiri",
  sub: "local-scan-test", iat: seconds, exp: seconds + 3600
});
const token = unsigned + "." + crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
let modelCalls = 0, modelRequests = [], responses = [scan(doc(ROWS))];
const logLines = [];
const server = createServer({
  env: { OPENAI_API_KEY: "local-test-only" },
  logger: { log: line => logLines.push(line), error: console.error },
  fetchImpl: async (url, options) => {
    if (url.includes("googleapis.com")) return Response.json({ keys: [jwk] });
    if (url !== "https://api.openai.com/v1/responses") throw new Error("Unexpected request: " + url);
    modelCalls++;
    modelRequests.push(JSON.parse(options.body));
    return Response.json({ output_text: JSON.stringify(responses.shift() || scan(doc(ROWS))), id: "local-test" });
  }
});
function requestScan(extra = {}) {
  return new Promise(resolve => {
    const request = Readable.from([Buffer.from(JSON.stringify({ ...extra, documents: [{
      noteIndex: 0, pages: ["data:image/jpeg;base64,YQ=="], expectedUnits: null, expectedLines: null
    }] }))]);
    request.method = "POST"; request.url = "/scan";
    request.socket = { remoteAddress: "127.0.0.1" };
    request.headers = { origin: "https://asafkiri.github.io", authorization: "Bearer " + token };
    const response = { headersSent: false, writeHead() { this.headersSent = true; }, write() {},
      end(body) { resolve(JSON.parse(body)); } };
    server.emit("request", request, response);
  });
}
try {
  const result = await requestScan();
  check("קריאה תקינה עם מחירון ומבצע מסתיימת בשתי קריאות עצמאיות", result.ok && modelCalls === 2, JSON.stringify(result));
  check("אין קריאה חוזרת מדומה", result.checksumRetryAttempted === false);
  check("המספרים המודפסים נשמרים ללא שינוי", JSON.stringify(result.scan) === JSON.stringify(scan(doc(ROWS))));
  const schema = modelRequests[0].text.format.schema.properties.documents.items.properties.rows.items;
  check("הבדיקה משתמשת בדיוק בשדות השורה שבסכימה", ROWS.every(r => Object.keys(r).sort().join() === Object.keys(schema.properties).sort().join()));
  const docSchema = modelRequests[0].text.format.schema.properties.documents.items;
  const V7 = ["headerText", "internalNumber", "numerator", "printedCheck", "otherPapersVisible", "notDriverStrip"];
  check("v7: השדות החדשים בסכימה וכולם חובה (מצב strict)", V7.every(f => docSchema.properties[f] && docSchema.required.includes(f))
    && Object.keys(docSchema.properties).sort().join() === docSchema.required.slice().sort().join());
  check("v7: אותם שדות בדיוק כמו בפלט המדומה", Object.keys(paper141()).sort().join() === Object.keys(docSchema.properties).sort().join());
  const systemText = modelRequests[0].input[0].content[0].text;
  check("v7: ההנחיה מכירה את ניירות המסופון הקצרים ואת דף ה-A4", systemText.includes("ת.משלוח החזרה יבש") && /\b15\. headerText/.test(systemText)
    && systemText.includes("notDriverStrip הוא true") && systemText.includes("otherPapersVisible הוא true"));
  check("v7: הניסוח מבהיר ספרות בלבד, נייר אחר = מספר אחר, ו-A4 כחריג היחיד לכללים 9 ו-11",
    systemText.includes("הספרות בלבד של \"מספר תעודה פנימי\"") && systemText.includes("עם מספר תעודה אחר משלו")
    && systemText.includes("זה החריג היחיד לכללים 9 ו-11") && systemText.includes("גם כשהצילום מטושטש"));
  check("v7: ההנחיה הקודמת לא נמחקה", systemText.includes("14. לפני הפלט בצע בדיקה פנימית") && systemText.includes("ח.משלוח החזרה"));
  responses = [scan(badQty), scan(doc(ROWS)), scan(doc(ROWS))]; modelCalls = 0;
  const retried = await requestScan();
  check("שגיאת כמות אמיתית מפעילה קריאה מתקנת אחת אחרי הקריאה הכפולה", retried.ok && modelCalls === 3 && retried.checksumRetryAttempted === true);
  check("התשובה המתוקנת נבחרת", retried.scan.documents[0].rows[0].quantity === 30);
  check("שני המודלים הזולים עצמאיים והאימות במודל הגיבוי", modelRequests.slice(-3).map(r => r.model).join() === 'gpt-5.6-luna,gpt-5.6-luna,gpt-5.6-terra');
  // v6: התשובה והיומן אומרים מה הפעיל את הקריאה השלישית
  check("התשובה שומרת מה הפעיל את הקריאה השלישית", retried.serviceVersion === 7 && Object.keys(retried.verification.triggerSummary || {}).length > 0
    && retried.verification.triggers.every(t => t.field && t.reason), JSON.stringify(retried.verification));
  const logged = logLines.map(l => JSON.parse(l)).filter(l => l.message === "scan_escalation");
  const LOG_KEYS = "message,mode,moneyOnly,readCount,serviceVersion,severity,status,triggerSummary";
  check("שורת יומן אחת לקריאה השלישית, בלי מספרים מהנייר", logged.length === 1 && logged[0].mode === "scan"
    && Object.keys(logged[0]).sort().join() === LOG_KEYS
    && logged[0].moneyOnly === retried.verification.moneyOnly
    && JSON.stringify(logged[0].triggerSummary) === JSON.stringify(retried.verification.triggerSummary)
    && !JSON.stringify(logged[0]).includes(String(ROWS[0].quantity)), JSON.stringify(logged));
  check("קריאה תקינה בלי הסלמה אינה כותבת שורת יומן", logLines.filter(l => l.includes('"scan_escalation"')).length === 1);
  responses = [scan(doc(ROWS))]; modelCalls = 0;
  const verifiedPrice = await requestScan({ mode: 'verify', verificationTargets: [{ noteIndex: 0, sourcePage: 1, lineNumber: 12, field: 'unitPriceExVat' }] });
  check("בקשת אימות מחיר מפעילה רק קריאה אחת ב-Terra", verifiedPrice.ok && modelCalls === 1 && modelRequests.at(-1).model === 'gpt-5.6-terra');
  check("בקשת האימות משתמשת בצילום המקורי", modelRequests.at(-1).input[1].content.some(c => c.type === 'input_image' && c.image_url === 'data:image/jpeg;base64,YQ=='));
  check("בקשת אימות של הלקוח נרשמת כמקור ההסלמה", verifiedPrice.verification.triggerSummary['client_request:unitPriceExVat'] === 1
    && verifiedPrice.verification.moneyOnly === true
    && logLines.map(l => JSON.parse(l)).filter(l => l.mode === "verify" && l.moneyOnly === true && Object.keys(l).sort().join() === LOG_KEYS).length === 1);
  responses = [scan(paper141()), scan(paper141())]; modelCalls = 0;
  const small = await requestScan();
  check("v7: נייר חיוב קצר נסגר בשתי קריאות, והשדות החדשים מגיעים ללקוח", small.ok && modelCalls === 2 && small.verification.status === "agreed"
    && small.scan.documents[0].headerText === "ת.משלוח" && small.scan.documents[0].printedCheck === 111 && small.scan.documents[0].numerator === "95141");
  responses = [scan({ ...paper141(), internalNumber: "N290095159" }), scan(paper141())]; modelCalls = 0;
  const withN = await requestScan();
  check("v7: מספר פנימי עם N בקריאה זולה אחת אינו מפעיל קריאה בתשלום", withN.ok && modelCalls === 2 && withN.verification.status === "agreed", JSON.stringify(withN.verification));
  responses = [scan(a4()), scan(a4())]; modelCalls = 0;
  const logsBefore = logLines.length;
  const notStrip = await requestScan();
  check("v7: דף A4 — שתי הקריאות הזולות מסכימות שאינו נייר מסופון, ואין קריאה שלישית בתשלום",
    modelCalls === 2 && notStrip.verification.escalationAttempted === false && notStrip.verification.notDriverStrip === true
    && notStrip.verification.status === "needs_review" && notStrip.verification.issues.length > 0, JSON.stringify(notStrip.verification));
  check("v7: הדילוג נרשם ביומן — כדי למדוד כמה פעמים הוא קורה על נייר אמיתי",
    logLines.slice(logsBefore).map(l => JSON.parse(l)).filter(l => l.message === "scan_not_driver_strip"
      && Object.keys(l).sort().join() === "message,readCount,reasons,serviceVersion,severity").length === 1);
  responses = [scan({ ...paper141(), notDriverStrip: true }), scan({ ...paper141(), notDriverStrip: true, rows: paper141().rows.map((r, i) => i ? { ...r, quantity: 3 } : { ...r, quantity: 12 }) }), scan(paper141())]; modelCalls = 0;
  const flaggedStrip = await requestScan();
  check("v7: סרט אמיתי ששתי הקריאות סימנו בטעות כ'לא נייר' — עם שורות שאינן מסכימות — עדיין משלם על הקריאה החזקה",
    modelCalls === 3 && flaggedStrip.verification.escalationAttempted === true && !flaggedStrip.verification.notDriverStrip, JSON.stringify(flaggedStrip.verification));
  responses = [scan(a4()), scan({ ...a4(), notDriverStrip: false }), scan(a4())]; modelCalls = 0;
  const unsure = await requestScan();
  check("v7: כשרק קריאה אחת חושבת שזה לא נייר מסופון — הקריאה החזקה רצה כרגיל",
    modelCalls === 3 && unsure.verification.escalationAttempted === true && !unsure.verification.notDriverStrip);
  modelCalls = 0;
  const invalidTarget = await requestScan({ mode: 'verify', verificationTargets: [{ noteIndex: 0, field: 'instructions', text: 'arbitrary prompt' }] });
  check("הנחיות אימות לא תקינות נדחות לפני קריאת המודל", invalidTarget.ok === false && invalidTarget.error === 'invalid_verification_targets' && modelCalls === 0);
} finally {
  server.close();
}

console.log(`\n${fail ? `✗ ${fail} נכשלו` : "✓ הכל עבר"} (${pass}/${pass + fail})`);
process.exit(fail ? 1 : 0);
