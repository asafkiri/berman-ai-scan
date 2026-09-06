// בדיקות ל-scanChecksumMismatches — עוגן הביקורת של הקריאה.
// הרצה: node test-checksum.mjs
//
// v62 שינה כאן דבר אחד: מסמך שלא הוקלד לו עוגן (זרימת הצילום-תחילה בלקוח)
// כבר אינו מדלג על הבדיקה, אלא נמדד מול בלוק הסיכום שמודפס בתחתית אותו
// נייר. הבדיקות מוודאות גם שההתנהגות הישנה — עם עוגן מוקלד — לא זזה.
import { scanChecksumMismatches } from "./server.js";

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ""}`); }
}
function section(title) { console.log(`\n${title}`); }

function row(quantity, lineTotalExVat) { return { quantity, lineTotalExVat }; }
// תעודה כפי שהמודל מחזיר אותה, עם בלוק סיכום שמסכים עם השורות
function doc(rows, overrides) {
  const total = Math.round(rows.reduce((sum, item) => sum + item.lineTotalExVat, 0) * 100) / 100;
  const units = rows.reduce((sum, item) => sum + item.quantity, 0);
  return Object.assign({
    noteIndex: 0, rows, totalUnits: units, printedLines: rows.length, netToChargeExVat: total,
  }, overrides || {});
}
const ROWS = [row(30, 172.22), row(13, 110.50), row(7, 84.33), row(15, 32.49), row(6, 57.91)];
const scan = document => ({ documents: [document] });
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
badQty.rows = [row(20, 114.82)].concat(ROWS.slice(1)); // 30 נקרא כ-20
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

section("[5] בלי עוגן — בדיקת הכסף");
const nearMiss = doc(ROWS);
nearMiss.netToChargeExVat = Math.round((nearMiss.netToChargeExVat + 0.08) * 100) / 100;
check("8 אגורות עיגול של הספק אינן ממצא",
  scanChecksumMismatches(scan(nearMiss), noAnchor).length === 0);
const priceOff = doc(ROWS);
priceOff.netToChargeExVat = Math.round((priceOff.netToChargeExVat + 4.4) * 100) / 100;
const m5 = scanChecksumMismatches(scan(priceOff), noAnchor);
check("מחיר שנקרא שגוי כן ממצא", m5.length === 1 && m5[0].moneyOff === true);
check("היחידות והשורות עדיין נסגרות", m5[0].unitsOff === false && m5[0].linesOff === false);

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

console.log(`\n${fail ? `✗ ${fail} נכשלו` : "✓ הכל עבר"} (${pass}/${pass + fail})`);
process.exit(fail ? 1 : 0);
