// בדיקות ל-scanChecksumMismatches — עוגן הביקורת של הקריאה.
// הרצה: node test-checksum.mjs
//
// v62 שינה כאן דבר אחד: מסמך שלא הוקלד לו עוגן (זרימת הצילום-תחילה בלקוח)
// כבר אינו מדלג על הבדיקה, אלא נמדד מול בלוק הסיכום שמודפס בתחתית אותו
// נייר. הבדיקות מוודאות גם שההתנהגות הישנה — עם עוגן מוקלד — לא זזה.
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { scanChecksumMismatches, validModelScan, createServer } from "./server.js";

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ""}`); }
}
function section(title) { console.log(`\n${title}`); }

// Match the real model schema: it has unitPriceExVat, never lineTotalExVat.
function row(quantity, unitPriceExVat) {
  return { sourcePage: 1, lineNumber: null, barcode: null, itemCode: null,
    description: "test bread", quantity, unitPriceExVat, confidence: 1 };
}
// תעודה כפי שהמודל מחזיר אותה, עם בלוק סיכום שמסכים עם השורות
function doc(rows, overrides) {
  const units = rows.reduce((sum, item) => sum + item.quantity, 0);
  return Object.assign({
    noteIndex: 0, rows, totalUnits: units, printedLines: rows.length, netToChargeExVat: 457.45,
    docNumber: null, docType: "invoice", docDate: "07/09/2026", pageCount: 1,
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
function requestScan() {
  return new Promise(resolve => {
    const request = Readable.from([Buffer.from(JSON.stringify({ documents: [{
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
  check("קריאה תקינה עם מחירון ומבצע מסתיימת בבקשת מודל אחת", result.ok && modelCalls === 1, JSON.stringify(result));
  check("אין קריאה חוזרת מדומה", result.checksumRetryAttempted === false);
  check("המספרים המודפסים נשמרים ללא שינוי", JSON.stringify(result.scan) === JSON.stringify(scan(doc(ROWS))));
  const schema = modelRequests[0].text.format.schema.properties.documents.items.properties.rows.items;
  check("הבדיקה משתמשת בדיוק בשדות השורה שבסכימה", ROWS.every(r => Object.keys(r).sort().join() === Object.keys(schema.properties).sort().join()));
  responses = [scan(badQty), scan(doc(ROWS))]; modelCalls = 0;
  const retried = await requestScan();
  check("שגיאת כמות אמיתית עדיין מפעילה קריאה מתקנת אחת", retried.ok && modelCalls === 2 && retried.checksumRetryAttempted === true);
  check("התשובה המתוקנת נבחרת", retried.scan.documents[0].rows[0].quantity === 30);
} finally {
  server.close();
}

console.log(`\n${fail ? `✗ ${fail} נכשלו` : "✓ הכל עבר"} (${pass}/${pass + fail})`);
process.exit(fail ? 1 : 0);

