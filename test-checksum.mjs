// בדיקות ל-scanChecksumMismatches — עוגן הביקורת של הקריאה.
// הרצה: node test-checksum.mjs
//
// v62 שינה כאן דבר אחד: מסמך שלא הוקלד לו עוגן (זרימת הצילום-תחילה בלקוח)
// כבר אינו מדלג על הבדיקה, אלא נמדד מול בלוק הסיכום שמודפס בתחתית אותו
// נייר. הבדיקות מוודאות גם שההתנהגות הישנה — עם עוגן מוקלד — לא זזה.
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { scanChecksumMismatches, validModelScan, createServer, separateDocumentsFirstPage } from "./server.js";

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

section("[10] SERVICE_VERSION 6 — תעודה שנייה בתוך קבוצת תמונות אחת");
// 20.9.2026: תעודת משלוח ולצידה תעודה שנייה של אותו משלוח צולמו ככרטיס אחד.
// המודל החזיר את הסיכום של העמוד הראשון ואת שורות שני העמודים, ובלי שדה
// מובנה יכול היה רק להתריע במילים — והבדיקה כאן נכשלה על 79 מול 71 ו-6 מול 5.
const secondNote = { ...row(8, 7.95), sourcePage: 2, itemCode: "238" };
const twoPages = [{ noteIndex: 0, pages: ["p1", "p2"], expectedUnits: null, expectedLines: null }];
// בלוק הסיכום שנקרא הוא של העמוד הראשון בלבד: 71 יח׳ ו-5 שורות.
const twoNotes = doc(ROWS.concat([secondNote]), { pageCount: 2, totalUnits: 71, printedLines: 5, separateDocuments: [{ sourcePage: 2, docNumber: "290094585" }] });
check("הדיווח תקין בסכימה", validModelScan(scan(twoNotes), twoPages));
check("שורות התעודה השנייה אינן נמדדות מול הסיכום של הראשונה", scanChecksumMismatches(scan(twoNotes), twoPages).length === 0, JSON.stringify(scanChecksumMismatches(scan(twoNotes), twoPages)));
const unreported = doc(ROWS.concat([secondNote]), { pageCount: 2, totalUnits: 71, printedLines: 5, separateDocuments: [] });
const m10 = scanChecksumMismatches(scan(unreported), twoPages);
check("בלי דיווח — הממצא הישן נשאר (79 מול 71, 6 מול 5)", m10.length === 1 && m10[0].unitsOff === true && m10[0].linesOff === true, JSON.stringify(m10));
// דיווח שגוי אינו מכבה את הביקורת: העמוד הראשון לבדו אינו נסגר על הסיכום.
const wrongSplit = doc(ROWS.slice(0, 3).concat(ROWS.slice(3).map(r => ({ ...r, sourcePage: 2 }))),
  { pageCount: 2, separateDocuments: [{ sourcePage: 2, docNumber: null }] });
const m10b = scanChecksumMismatches(scan(wrongSplit), twoPages);
check("דיווח שגוי על פיצול נתפס — העמוד הראשון אינו נסגר לבדו", m10b.length === 1 && m10b[0].unitsOff === true && m10b[0].linesOff === true, JSON.stringify(m10b));
check("תעודה של שני עמודים בלי דיווח נמדדת על שני העמודים",
  scanChecksumMismatches(scan(doc(ROWS.slice(0, 3).concat(ROWS.slice(3).map(r => ({ ...r, sourcePage: 2 }))), { pageCount: 2, separateDocuments: [] })), twoPages).length === 0);
check("עמוד מחוץ לטווח נדחה", !validModelScan(scan(doc(ROWS, { separateDocuments: [{ sourcePage: 3, docNumber: null }] })), twoPages));
check("עמוד 1 אינו תעודה נוספת — נדחה", !validModelScan(scan(doc(ROWS, { separateDocuments: [{ sourcePage: 1, docNumber: null }] })), twoPages));
check("עמוד שדווח פעמיים נדחה", !validModelScan(scan(doc(ROWS, { pageCount: 2, separateDocuments: [{ sourcePage: 2, docNumber: "1" }, { sourcePage: 2, docNumber: "2" }] })), twoPages));
check("מספר תעודה שאינו מחרוזת נדחה", !validModelScan(scan(doc(ROWS, { separateDocuments: [{ sourcePage: 2, docNumber: 290094585 }] })), twoPages));
check("מבנה שאינו מערך נדחה", !validModelScan(scan(doc(ROWS, { separateDocuments: { sourcePage: 2 } })), twoPages));
check("פלט בלי השדה (סכימה ישנה) עדיין תקין", validModelScan(scan(doc(ROWS)), [{ noteIndex: 0, pages: ["image"] }]));
check("separateDocumentsFirstPage מיוצא מהשרת כמו קודם", separateDocumentsFirstPage(twoNotes) === 2 && separateDocumentsFirstPage(doc(ROWS)) === null);

section("[9] מסלול הבקשה המלא בזיכרון — בלי פתיחת חיבור רשת");
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
const server = createServer({
  env: { OPENAI_API_KEY: "local-test-only" },
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
  const documentSchema = modelRequests[0].text.format.schema.properties.documents.items;
  const schema = documentSchema.properties.rows.items;
  check("הבדיקה משתמשת בדיוק בשדות השורה שבסכימה", ROWS.every(r => Object.keys(r).sort().join() === Object.keys(schema.properties).sort().join()));
  check("separateDocuments נשלח למודל כשדה חובה (סכימה קפדנית)",
    documentSchema.required.includes("separateDocuments") && documentSchema.properties.separateDocuments.items.required.join() === "sourcePage,docNumber");
  check("ההנחיה למודל מסבירה מה לעשות עם תעודה שנייה בקבוצה", modelRequests[0].input[0].content[0].text.includes("separateDocuments"));
  responses = [scan(badQty), scan(doc(ROWS)), scan(doc(ROWS))]; modelCalls = 0;
  const retried = await requestScan();
  check("שגיאת כמות אמיתית מפעילה קריאה מתקנת אחת אחרי הקריאה הכפולה", retried.ok && modelCalls === 3 && retried.checksumRetryAttempted === true);
  check("התשובה המתוקנת נבחרת", retried.scan.documents[0].rows[0].quantity === 30);
  check("שני המודלים הזולים עצמאיים והאימות במודל הגיבוי", modelRequests.slice(-3).map(r => r.model).join() === 'gpt-5.6-luna,gpt-5.6-luna,gpt-5.6-terra');
  responses = [scan(doc(ROWS))]; modelCalls = 0;
  const verifiedPrice = await requestScan({ mode: 'verify', verificationTargets: [{ noteIndex: 0, sourcePage: 1, lineNumber: 12, field: 'unitPriceExVat' }] });
  check("בקשת אימות מחיר מפעילה רק קריאה אחת ב-Terra", verifiedPrice.ok && modelCalls === 1 && modelRequests.at(-1).model === 'gpt-5.6-terra');
  check("בקשת האימות משתמשת בצילום המקורי", modelRequests.at(-1).input[1].content.some(c => c.type === 'input_image' && c.image_url === 'data:image/jpeg;base64,YQ=='));
  modelCalls = 0;
  const invalidTarget = await requestScan({ mode: 'verify', verificationTargets: [{ noteIndex: 0, field: 'instructions', text: 'arbitrary prompt' }] });
  check("הנחיות אימות לא תקינות נדחות לפני קריאת המודל", invalidTarget.ok === false && invalidTarget.error === 'invalid_verification_targets' && modelCalls === 0);
} finally {
  server.close();
}

console.log(`\n${fail ? `✗ ${fail} נכשלו` : "✓ הכל עבר"} (${pass}/${pass + fail})`);
process.exit(fail ? 1 : 0);
