import { useState, useEffect } from "react";
import { supabase } from "./lib/supabase";
import { toRow, fromRow } from "./lib/tradeMap";
import { parseIBKRCsv } from "./lib/ibkrParser";
import { parseIBICsv } from "./lib/ibiParser";
import { parseBlinkPdf } from "./lib/blinkParser";

// ברוקר → הגדרות ייבוא: סיומת, אופן קריאה (טקסט/בינארי) והפרסר.
const IMPORTERS = {
  IBKR: { label: "CSV", accept: ".csv", binary: false, parse: parseIBKRCsv },
  IBI: { label: "CSV", accept: ".csv", binary: false, parse: parseIBICsv },
  Blink: { label: "PDF", accept: ".pdf", binary: true, parse: parseBlinkPdf },
};
import Login from "./components/Login";

const STORAGE_KEY = "trade_journal_v1";
const MIGRATED_KEY = "trade_journal_migrated";

// "DayTrade" = rows pushed automatically by the DayTrade bot's journal_sync.py.
// This list is a hard filter (see brokerTrades below) — a row whose broker is not
// here is fetched from Supabase and then never rendered anywhere.
const BROKERS = ["IBKR", "IBI", "Blink", "DayTrade"];
const BROKER_KEY = "trade_journal_broker";

const SETUP_TYPES = ["News/Catalyst", "Breakout", "Reversal", "Continuation", "VWAP", "Other"];
const EMOTIONS = ["FOMO", "Confident", "Hesitant", "Neutral", "Greedy", "Fearful"];
const MISTAKES = [
  "Chased after spike",
  "Stop too tight",
  "Stop too wide",
  "Wrong position size",
  "No technical basis",
  "Panic exit",
  "No plan before entry",
  "Ignored market context",
];

// רווח/הפסד נטו בדולרים: כמות × (יציאה − כניסה), הפוך לשורט, פחות עמלה.
// null אם חסר ערך. עמלה חסרה נחשבת 0, כך שטריידים בלי נתוני עמלה (ידניים,
// IBI, Blink) לא מושפעים. כל התצוגות — לוח שנה, גרף הון, האריחים והפילוחים —
// עוברות דרך הפונקציה הזו, ולכן כולן נטו.
const tradeDollarPnl = (t) => {
  const qty = parseFloat(t.quantity);
  const entry = parseFloat(t.entryPrice);
  const exit = parseFloat(t.exitPrice);
  if (isNaN(qty) || isNaN(entry) || isNaN(exit)) return null;
  const gross = (t.direction === "Short" ? entry - exit : exit - entry) * qty;
  const comm = parseFloat(t.commission);
  return gross - (isNaN(comm) ? 0 : comm);
};

// רווח/הפסד ברוטו — לפני עמלה. משמש רק להצגה לצד הנטו.
const tradeGrossPnl = (t) => {
  const qty = parseFloat(t.quantity);
  const entry = parseFloat(t.entryPrice);
  const exit = parseFloat(t.exitPrice);
  if (isNaN(qty) || isNaN(entry) || isNaN(exit)) return null;
  return (t.direction === "Short" ? entry - exit : exit - entry) * qty;
};

// התאריך שבו ה-P&L מומש — זה התאריך שלפיו מקבצים בלוח השנה ובגרף ההון, כי
// רווח נרשם ביום הסגירה ולא ביום הפתיחה.
// ⚠ `date` לא אומר אותו דבר בכל הברוקרים: ייבוא CSV/PDF שם בו את תאריך
// הפתיחה (ואת הסגירה ב-exitDate), ואילו הבוט DayTrade שם בו כבר את תאריך
// הסגירה ואין לו exitDate כלל (journal_sync.py:_trade_date). לכן exitDate
// קודם ו-date הוא הנפילה — נכון לשני המקרים. טריידים שיובאו לפני שהעמודה
// exit_date נוספה נשארים על תאריך הפתיחה עד ייבוא חוזר שימלא אותה.
const pnlDate = (t) => t.exitDate || t.date;

// ── זמן שוק ומשך החזקה ─────────────────────────────────────────────────────
// כל חישובי השעה נעשים בזמן שוק (ניו-יורק), לא בזמן הדפדפן — כך שטרייד ידני
// ומיובא נופלים לאותו דלי שעה. ה-formatters נבנים פעם אחת: בנייה שלהם עולה
// זמן והם רצים לכל טרייד בכל render.
const MARKET_TZ = "America/New_York";

const ET_HM = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TZ, hour: "2-digit", minute: "2-digit", hour12: false, hourCycle: "h23",
});
// דקה-ביום בזמן שוק. ה-% 24 מגן מפני מנועים שמחזירים "24" לחצות, מה שהיה
// ממיין טרייד של 00:xx אחרי כל השאר.
const etMinutes = (ms) => {
  const p = ET_HM.formatToParts(ms);
  const h = Number(p.find(x => x.type === "hour").value) % 24;
  return h * 60 + Number(p.find(x => x.type === "minute").value);
};

// תאריך לוח בזמן שוק ("2026-07-17"); en-CA מפרמט כ-YYYY-MM-DD.
const ET_YMD = new Intl.DateTimeFormat("en-CA", {
  timeZone: MARKET_TZ, year: "numeric", month: "2-digit", day: "2-digit",
});
const etDate = (ms) => ET_YMD.format(ms);

// timestamptz שנשמר -> מילישניות. PostgREST תמיד פולט offset מפורש, ולכן
// Date.parse בטוח כאן (בניגוד למחרוזת עם קיצור אזור זמן).
const tradeInstant = (v) => {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
};

// הפרש ימים שלמים בין שני "YYYY-MM-DD". נבנה מ-Date.UTC על החלקים: ל-UTC אין
// שעון קיץ, אז טווח שחוצה מעבר שעון עדיין יוצא מספר שלם.
// ⚠ לא new Date(str) − new Date(str): "2026-07-17" נקרא כחצות UTC ואילו
// new Date(2026,6,17) כחצות מקומית, וערבוב הצורות הוא שגיאת יום שקטה.
const dayDiff = (a, b) => {
  if (!a || !b) return null;
  const p = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(b) - p(a)) / 86400000);
};

const MAX_HOLD_MIN = 365 * 24 * 60;

// משך החזקה מדורג. אף פעם לא מחזיר הערכה במסווה של מדידה:
//   { tier: "exact",   minutes, days }  שני חותמי הזמן קיימים
//   { tier: "days",    days }           רק תאריכים, ויציאה ביום מאוחר יותר
//   { tier: "unknown" }                 אותו יום בלי שעות, או פוזיציה פתוחה
// ⚠ "אותו יום בלי שעות" הוא unknown ולא אפס — זה יכול להיות דקה או 6.5 שעות.
// הדרגה היא ערך ולא דגל על מספר, כדי שאי אפשר יהיה לממצע בטעות בין דרגות.
const holdTime = (t) => {
  const a = tradeInstant(t.entryAt), b = tradeInstant(t.exitAt);
  if (a != null && b != null) {
    const minutes = (b - a) / 60000;
    // שלילי = שיוך פגום; מעל שנה = כמעט בוודאי פרסור שגוי. בשני המקרים נופלים
    // לדרגת הימים במקום לצייר שטות.
    if (minutes >= 0 && minutes <= MAX_HOLD_MIN) {
      // ימי לוח נגזרים מהחותמים עצמם ולא מ-date/exitDate, כי אלה אומרים דברים
      // שונים בברוקרים שונים (ראה pnlDate) — כך זה נכון לכל מקור בלי יוצא דופן.
      return { tier: "exact", minutes, days: dayDiff(etDate(a), etDate(b)) };
    }
  }
  const d = dayDiff(t.date, t.exitDate);
  if (d != null && d > 0) return { tier: "days", days: d };
  return { tier: "unknown" };
};

const fmtMinutes = (m) => {
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 60 * 24) {
    const h = Math.floor(m / 60), r = Math.round(m % 60);
    return r ? `${h}h ${r}m` : `${h}h`;
  }
  return `${(m / 1440).toFixed(1)}d`;
};

// תווית מודעת-דרגה. "~" הוא הסימן היחיד להערכה; unknown מחזיר null כדי
// שהקורא ישמיט את האלמנט לגמרי ("—" נקרא כמו אפס).
const holdLabel = (t) => {
  const h = holdTime(t);
  if (h.tier === "exact") return { text: fmtMinutes(h.minutes), title: "Exact hold time" };
  if (h.tier === "days") return { text: `~${h.days}d`, title: "Approximate — only dates were recorded, no intraday times" };
  return null;
};

// דליי משך החזקה. הדליים התוך-יומיים נגישים רק מדרגת exact; דליי הסווינג
// נגישים משתי הדרגות ומשמעותם זהה בשתיהן (מספר לילות), ולכן טרייד של 26 שעות
// נופל ל-"1-3d" בין אם החותמים שרדו ובין אם לא — בלי תפר בין מדוד למשוער.
const HOLD_BUCKETS = [
  { key: "<5m", label: "< 5m" },
  { key: "5-30m", label: "5 – 30m" },
  { key: "30m-2h", label: "30m – 2h" },
  { key: "2h-day", label: "2h – close" },
  { key: "1-3d", label: "1 – 3d" },
  { key: "3-10d", label: "3 – 10d" },
  { key: "10d+", label: "10d +" },
  { key: "?", label: "Unknown" },
];

const holdBucket = (t) => {
  const h = holdTime(t);
  if (h.tier === "unknown") return "?";
  // כל מה שחצה לילה מסווג לפי לילות ולא לפי שעות שעון — זה הציר ששתי הדרגות
  // יכולות לבטא ביושר, וכך הדליים התוך-יומיים מכילים רק נתונים שנמדדו.
  if (h.days > 0) return h.days <= 3 ? "1-3d" : h.days <= 10 ? "3-10d" : "10d+";
  const m = h.minutes;
  return m < 5 ? "<5m" : m < 30 ? "5-30m" : m < 120 ? "30m-2h" : "2h-day";
};

// דליי שעת כניסה. הגבולות בדקות-ביום ולא בשעות שלמות, כדי ש-09:30 יעבוד —
// דלי לפי שעה בלבד היה משייך מילוי פרה-מרקט של 09:15 לשורת פתיחת המסחר.
const HOUR_BUCKETS = [
  { label: "Pre", lo: 0, hi: 570 },
  { label: "09:30", lo: 570, hi: 600 },
  { label: "10:00", lo: 600, hi: 660 },
  { label: "11:00", lo: 660, hi: 720 },
  { label: "12:00", lo: 720, hi: 780 },
  { label: "13:00", lo: 780, hi: 840 },
  { label: "14:00", lo: 840, hi: 900 },
  { label: "15:00", lo: 900, hi: 960 },
  { label: "Post", lo: 960, hi: 1440 },
];

// ── המרה בין שעון-קיר בזמן שוק לבין חותם זמן מוחלט (להזנה ידנית) ──────────
const ET_FULL = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TZ, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});
// ההיסט של ניו-יורק ברגע נתון, במילישניות.
const etOffsetMs = (ms) => {
  const p = Object.fromEntries(ET_FULL.formatToParts(ms).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms;
};
// ("2026-07-17", "09:41") כזמן שוק -> חותם ISO, או null.
const etWallToIso = (date, time) => {
  if (!date || !time) return null;
  const [y, mo, d] = date.split("-").map(Number);
  const [hh, mi] = time.split(":").map(Number);
  if ([y, mo, d, hh, mi].some(Number.isNaN)) return null;
  const naive = Date.UTC(y, mo - 1, d, hh, mi, 0);
  // שני מעברים: הבדיקה הראשונה קוראת את ההיסט ברגע השגוי כששעון-הקיר נמצא
  // בתוך שעה ממעבר שעון; בדיקה חוזרת עם הרגע המתוקן מתכנסת. (הפער של מעבר
  // האביב והחפיפה של הסתיו נשארים דו-משמעיים פורמלית — אבל הם ב-2 בלילה.)
  const ms = naive - etOffsetMs(naive - etOffsetMs(naive));
  return new Date(ms).toISOString();
};
const isoToEtTime = (iso) => {
  const ms = tradeInstant(iso);
  if (ms == null) return "";
  const p = Object.fromEntries(ET_FULL.formatToParts(ms).map(x => [x.type, x.value]));
  return `${String(+p.hour % 24).padStart(2, "0")}:${p.minute}`;
};

// שווי הפוזיציה בדולרים: כמות × מחיר כניסה. null אם חסר ערך.
const tradePositionValue = (t) => {
  const qty = parseFloat(t.quantity);
  const entry = parseFloat(t.entryPrice);
  if (isNaN(qty) || isNaN(entry)) return null;
  return qty * entry;
};

const fmtUsd = (n, signed = false) =>
  `${n < 0 ? "-" : signed && n > 0 ? "+" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

// "2026-07" -> "July 2026"
const monthLabel = (ym) => {
  const [y, m] = ym.split("-");
  return new Date(+y, +m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
};

// ⚠ בכוונה בלי externalId: טרייד ידני חייב להישאר עם external_id ריק כדי
// שהאינדקס הייחודי יתייחס לכל אחד כנפרד.
const emptyTrade = (broker = "IBKR") => ({
  date: new Date().toISOString().slice(0, 10),
  exitDate: "",
  entryAt: "",
  exitAt: "",
  commission: "",
  ticker: "",
  direction: "Long",
  broker,
  setupType: "",
  catalyst: "",
  quantity: "",
  entryPrice: "",
  stopPrice: "",
  exitPrice: "",
  pnl: "",
  emotionEntry: "",
  mistakes: [],
  whatWentRight: "",
  whatWentWrong: "",
  lesson: "",
  wouldRetake: null,
});

function Tag({ label, selected, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "4px 12px",
        borderRadius: 2,
        border: selected ? "1.5px solid #e8c84a" : "1.5px solid #444",
        background: selected ? "#e8c84a15" : "transparent",
        color: selected ? "#e8c84a" : "#aaa",
        fontSize: 12,
        fontFamily: "'IBM Plex Mono', monospace",
        cursor: "pointer",
        transition: "all 0.15s",
        letterSpacing: "0.03em",
      }}
    >
      {label}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{
        fontSize: 10,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: "#aaa",
        marginBottom: 6,
        fontFamily: "'IBM Plex Mono', monospace",
      }}>{label}</div>
      {children}
    </div>
  );
}

function Input({ value, onChange, placeholder, type = "text" }) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: "100%",
        background: "#0d0d0d",
        border: "1px solid #2a2a2a",
        borderRadius: 2,
        padding: "8px 10px",
        color: "#e8e8e8",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 13,
        outline: "none",
        boxSizing: "border-box",
      }}
    />
  );
}

function Textarea({ value, onChange, placeholder, rows = 3 }) {
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      style={{
        width: "100%",
        background: "#0d0d0d",
        border: "1px solid #2a2a2a",
        borderRadius: 2,
        padding: "8px 10px",
        color: "#e8e8e8",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 13,
        outline: "none",
        resize: "vertical",
        boxSizing: "border-box",
      }}
    />
  );
}

function PnlBadge({ pnl }) {
  const val = parseFloat(pnl);
  if (isNaN(val)) return null;
  const color = val > 0 ? "#4caf7d" : val < 0 ? "#e05252" : "#888";
  return (
    <span
      title="Price-based return (entry → exit). Commission is not reflected here, so on commissioned trades this will not exactly match the dollar P&L, which is net."
      style={{
        color,
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 13,
        fontWeight: 600,
      }}>
      {val > 0 ? "+" : ""}{val}%
    </span>
  );
}

function TradeCard({ trade, onEdit, onDelete }) {
  const pnl = parseFloat(trade.pnl);
  const borderColor = isNaN(pnl) ? "#222" : pnl > 0 ? "#1e3d2a" : pnl < 0 ? "#3d1e1e" : "#222";
  const dollarPnl = tradeDollarPnl(trade);
  const posValue = tradePositionValue(trade);
  const hold = holdLabel(trade);
  const commission = parseFloat(trade.commission) || 0;

  return (
    <div style={{
      border: `1px solid ${borderColor}`,
      borderLeft: `3px solid ${isNaN(pnl) ? "#444" : pnl > 0 ? "#4caf7d" : "#e05252"}`,
      borderRadius: 3,
      padding: "14px 16px",
      marginBottom: 10,
      background: "#0a0a0a",
      cursor: onEdit ? "pointer" : "default",
    }} onClick={onEdit ? () => onEdit(trade) : undefined}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontWeight: 700,
            fontSize: 16,
            color: "#e8c84a",
            letterSpacing: "0.05em",
          }}>{trade.ticker || "—"}</span>
          {trade.quantity && (
            <span style={{
              fontSize: 11,
              color: "#888",
              fontFamily: "'IBM Plex Mono', monospace",
            }}>× {trade.quantity}{posValue != null ? ` · ${fmtUsd(posValue)}` : ""}</span>
          )}
          <span style={{
            fontSize: 10,
            color: "#888",
            fontFamily: "'IBM Plex Mono', monospace",
            letterSpacing: "0.08em",
          }}>{trade.date}</span>
          {trade.exitDate && trade.exitDate !== trade.date && (
            <span style={{
              fontSize: 10,
              color: "#666",
              fontFamily: "'IBM Plex Mono', monospace",
              letterSpacing: "0.08em",
            }} title="Exit date">→ {trade.exitDate}</span>
          )}
          {hold && (
            <span style={{
              fontSize: 10,
              color: "#666",
              fontFamily: "'IBM Plex Mono', monospace",
              letterSpacing: "0.08em",
            }} title={hold.title}>⏱ {hold.text}</span>
          )}
          {commission > 0 && (
            <span style={{
              fontSize: 10,
              color: "#666",
              fontFamily: "'IBM Plex Mono', monospace",
              letterSpacing: "0.08em",
            }} title="Commission (already deducted from the P&L shown)">
              fee ${commission.toFixed(2)}
            </span>
          )}
          {trade.setupType && (
            <span style={{
              fontSize: 10,
              color: "#aaa",
              fontFamily: "'IBM Plex Mono', monospace",
              border: "1px solid #2a2a2a",
              padding: "1px 6px",
              borderRadius: 2,
            }}>{trade.setupType}</span>
          )}
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {dollarPnl != null && (
            <span style={{
              color: dollarPnl > 0 ? "#4caf7d" : dollarPnl < 0 ? "#e05252" : "#888",
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 13,
              fontWeight: 600,
            }}>{fmtUsd(dollarPnl, true)}</span>
          )}
          <PnlBadge pnl={trade.pnl} />
          {onDelete && (
            <button onClick={e => { e.stopPropagation(); onDelete(trade.id); }} style={{
              background: "none", border: "none", color: "#777", cursor: "pointer", fontSize: 14, padding: "0 4px"
            }}>✕</button>
          )}
        </div>
      </div>
      {trade.lesson && (
        <div style={{
          fontSize: 12,
          color: "#aaa",
          fontFamily: "'IBM Plex Mono', monospace",
          borderTop: "1px solid #1a1a1a",
          marginTop: 8,
          paddingTop: 8,
          fontStyle: "italic",
        }}>
          ▸ {trade.lesson}
        </div>
      )}
      {trade.mistakes?.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 6 }}>
          {trade.mistakes.map(m => (
            <span key={m} style={{
              fontSize: 10,
              color: "#9b4444",
              border: "1px solid #3d1e1e",
              padding: "1px 6px",
              borderRadius: 2,
              fontFamily: "'IBM Plex Mono', monospace",
            }}>{m}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function TradeForm({ trade, onChange, onSave, onCancel, saving }) {
  const toggleMistake = (m) => {
    const cur = trade.mistakes || [];
    onChange("mistakes", cur.includes(m) ? cur.filter(x => x !== m) : [...cur, m]);
  };

  const riskReward = () => {
    const e = parseFloat(trade.entryPrice);
    const s = parseFloat(trade.stopPrice);
    const x = parseFloat(trade.exitPrice);
    if (!e || !s || !x) return null;
    const risk = Math.abs(e - s);
    const reward = Math.abs(x - e);
    if (risk === 0) return null;
    return (reward / risk).toFixed(2);
  };

  const rr = riskReward();
  const dollarPnl = tradeDollarPnl(trade);
  const grossPnl = tradeGrossPnl(trade);
  const posValue = tradePositionValue(trade);
  const hold = holdLabel(trade);

  const computedBox = (content, color) => (
    <div style={{
      padding: "8px 10px",
      border: "1px solid #1a1a1a",
      borderRadius: 2,
      color: color || "#777",
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: 13,
    }}>
      {content}
    </div>
  );

  return (
    <div style={{
      background: "#080808",
      border: "1px solid #1e1e1e",
      borderRadius: 4,
      padding: 24,
    }}>
      <div style={{
        fontSize: 11,
        letterSpacing: "0.15em",
        textTransform: "uppercase",
        color: "#888",
        marginBottom: 20,
        fontFamily: "'IBM Plex Mono', monospace",
        borderBottom: "1px solid #1a1a1a",
        paddingBottom: 12,
      }}>
        {trade.id ? `Edit / ${trade.ticker || "Trade"}` : "New Trade"}
      </div>

      {/* Row 1 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
        <Field label="Ticker">
          <Input value={trade.ticker} onChange={v => onChange("ticker", v.toUpperCase())} placeholder="AAPL" />
        </Field>
        <Field label="Date">
          <Input type="date" value={trade.date} onChange={v => onChange("date", v)} />
        </Field>
        <Field label="Direction">
          <div style={{ display: "flex", gap: 8 }}>
            {["Long", "Short"].map(d => (
              <Tag key={d} label={d} selected={trade.direction === d} onClick={() => onChange("direction", d)} />
            ))}
          </div>
        </Field>
      </div>

      {/* Row 2 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr", gap: 16 }}>
        <Field label="Qty (shares)">
          <Input type="number" value={trade.quantity} onChange={v => onChange("quantity", v)} placeholder="100" />
        </Field>
        <Field label="Entry $">
          <Input type="number" value={trade.entryPrice} onChange={v => onChange("entryPrice", v)} placeholder="0.00" />
        </Field>
        <Field label="Stop $">
          <Input type="number" value={trade.stopPrice} onChange={v => onChange("stopPrice", v)} placeholder="0.00" />
        </Field>
        <Field label="Exit $">
          <Input type="number" value={trade.exitPrice} onChange={v => onChange("exitPrice", v)} placeholder="0.00" />
        </Field>
        <Field label="Exit Date">
          <Input type="date" value={trade.exitDate} onChange={v => onChange("exitDate", v)} />
          {/* Empty = genuinely not recorded (trade predates this field, or still open) —
              not a fake/computed value. The blank box below is the browser's own
              empty-date placeholder, not real data. */}
          {!trade.exitDate && (
            <div style={{ fontSize: 10, color: "#555", marginTop: 4 }}>Not recorded — set manually if known</div>
          )}
        </Field>
      </div>

      {/* Row 3 — intraday times. Optional: leaving them empty keeps the trade
          date-only, exactly as before. Times are MARKET time (ET), which is the
          only reading under which a hand-typed trade lands in the same hour
          bucket as an imported one. The echo under each input shows the date it
          is being combined with — worth watching, because on DayTrade bot rows
          `date` holds the EXIT date. */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr", gap: 16 }}>
        <Field label="Entry Time (ET)">
          <Input type="time" value={isoToEtTime(trade.entryAt)}
            onChange={v => onChange("entryAt", etWallToIso(trade.date, v) || "")} />
          {trade.entryAt
            ? <div style={{ fontSize: 10, color: "#555", marginTop: 4 }}>→ {trade.date} {isoToEtTime(trade.entryAt)} ET</div>
            : <div style={{ fontSize: 10, color: "#555", marginTop: 4 }}>No time — hold time unknown</div>}
        </Field>
        <Field label="Exit Time (ET)">
          <Input type="time" value={isoToEtTime(trade.exitAt)}
            onChange={v => onChange("exitAt", etWallToIso(trade.exitDate || trade.date, v) || "")} />
          {trade.exitAt
            ? <div style={{ fontSize: 10, color: "#555", marginTop: 4 }}>→ {trade.exitDate || trade.date} {isoToEtTime(trade.exitAt)} ET</div>
            : <div style={{ fontSize: 10, color: "#555", marginTop: 4 }}>No time — hold time unknown</div>}
        </Field>
        <Field label="Commission $">
          <Input type="number" value={trade.commission} onChange={v => onChange("commission", v)} placeholder="0.00" />
        </Field>
        <Field label="Hold Time">
          {computedBox(hold ? hold.text : "—", hold ? "#e8e8e8" : null)}
        </Field>
        <Field label="P&L $ (gross)">
          {computedBox(
            grossPnl != null ? fmtUsd(grossPnl, true) : "—",
            grossPnl != null ? (grossPnl > 0 ? "#4caf7d" : grossPnl < 0 ? "#e05252" : "#888") : null,
          )}
        </Field>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 16 }}>
        <Field label="P&L %">
          <Input type="number" value={trade.pnl} onChange={v => onChange("pnl", v)} placeholder="-2.5" />
        </Field>
        <Field label="R:R">
          {computedBox(rr ? `1 : ${rr}` : "—", rr ? (parseFloat(rr) >= 1 ? "#4caf7d" : "#e05252") : null)}
        </Field>
        <Field label="Position $">
          {computedBox(posValue != null ? fmtUsd(posValue) : "—", posValue != null ? "#e8e8e8" : null)}
        </Field>
        <Field label="P&L $">
          {computedBox(
            dollarPnl != null ? fmtUsd(dollarPnl, true) : "—",
            dollarPnl != null ? (dollarPnl > 0 ? "#4caf7d" : dollarPnl < 0 ? "#e05252" : "#888") : null,
          )}
        </Field>
      </div>

      <Field label="Setup Type">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {SETUP_TYPES.map(s => (
            <Tag key={s} label={s} selected={trade.setupType === s} onClick={() => onChange("setupType", s)} />
          ))}
        </div>
      </Field>

      <Field label="Catalyst / News">
        <Input value={trade.catalyst} onChange={v => onChange("catalyst", v)} placeholder="What triggered the trade?" />
      </Field>

      <Field label="Emotion at Entry">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {EMOTIONS.map(e => (
            <Tag key={e} label={e} selected={trade.emotionEntry === e} onClick={() => onChange("emotionEntry", e)} />
          ))}
        </div>
      </Field>

      <Field label="Mistakes Made">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {MISTAKES.map(m => (
            <Tag key={m} label={m} selected={(trade.mistakes || []).includes(m)} onClick={() => toggleMistake(m)} />
          ))}
        </div>
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Field label="What Worked">
          <Textarea value={trade.whatWentRight} onChange={v => onChange("whatWentRight", v)} placeholder="What did I do right?" />
        </Field>
        <Field label="What Didn't Work">
          <Textarea value={trade.whatWentWrong} onChange={v => onChange("whatWentWrong", v)} placeholder="Where did I go wrong?" />
        </Field>
      </div>

      <Field label="Key Lesson (one sentence)">
        <Input value={trade.lesson} onChange={v => onChange("lesson", v)} placeholder="The lesson I'm taking away..." />
      </Field>

      <Field label="Would you take this trade again?">
        <div style={{ display: "flex", gap: 8 }}>
          {[{ v: true, l: "Yes — same setup" }, { v: false, l: "No — would skip" }].map(({ v, l }) => (
            <Tag key={l} label={l} selected={trade.wouldRetake === v} onClick={() => onChange("wouldRetake", v)} />
          ))}
        </div>
      </Field>

      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
        <button onClick={onCancel} disabled={saving} style={{
          padding: "8px 20px",
          background: "none",
          border: "1px solid #2a2a2a",
          color: "#aaa",
          borderRadius: 2,
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 12,
          cursor: saving ? "default" : "pointer",
          letterSpacing: "0.08em",
        }}>Cancel</button>
        <button onClick={onSave} disabled={saving} style={{
          padding: "8px 20px",
          background: "#e8c84a",
          border: "none",
          color: "#000",
          borderRadius: 2,
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 12,
          fontWeight: 700,
          cursor: saving ? "default" : "pointer",
          opacity: saving ? 0.6 : 1,
          letterSpacing: "0.08em",
        }}>{saving ? "Saving..." : "Save Trade"}</button>
      </div>
    </div>
  );
}

function Stats({ trades }) {
  if (trades.length === 0) return null;
  const withPnl = trades.filter(t => !isNaN(parseFloat(t.pnl)));
  const winners = withPnl.filter(t => parseFloat(t.pnl) > 0);
  const winRate = withPnl.length ? Math.round((winners.length / withPnl.length) * 100) : 0;
  // דולר P&L אמיתי, רק לטריידים שיש להם כמות + כניסה + יציאה.
  const totalPnl = trades.reduce((s, t) => s + (tradeDollarPnl(t) ?? 0), 0);

  const mistakeCounts = {};
  trades.forEach(t => (t.mistakes || []).forEach(m => { mistakeCounts[m] = (mistakeCounts[m] || 0) + 1; }));
  const topMistake = Object.entries(mistakeCounts).sort((a, b) => b[1] - a[1])[0];

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(4, 1fr)",
      gap: 1,
      background: "#111",
      border: "1px solid #1a1a1a",
      borderRadius: 3,
      overflow: "hidden",
      marginBottom: 24,
    }}>
      {[
        { label: "Total Trades", value: trades.length },
        { label: "Win Rate", value: `${winRate}%` },
        { label: "Total P&L", value: fmtUsd(totalPnl, true), color: totalPnl > 0 ? "#4caf7d" : "#e05252" },
        { label: "Top Mistake", value: topMistake ? topMistake[0] : "—" },
      ].map(({ label, value, color }) => (
        <div key={label} style={{ padding: "14px 16px", background: "#080808" }}>
          <div style={{ fontSize: 10, color: "#888", fontFamily: "'IBM Plex Mono', monospace", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
          <div style={{ fontSize: 18, fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, color: color || "#e8c84a" }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

const RANGE_KEYS = ["1M", "3M", "6M", "YTD", "1Y", "All"];

// תאריך חיתוך לטווח הנבחר; null = בלי חיתוך.
function rangeCutoff(key) {
  const now = new Date();
  if (key === "All") return null;
  if (key === "YTD") return `${now.getFullYear()}-01-01`;
  const months = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12 }[key];
  const d = new Date(now.getFullYear(), now.getMonth() - months, now.getDate());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// צעד "עגול" (1/2/5×10^n) לקווי הרשת של ציר ה-Y.
function niceStep(span, target = 5) {
  const raw = span / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

// גרף P&L מצטבר (דולרים, טריידים סגורים בלבד) עם בחירת טווח זמן.
export function PerformanceView({ trades }) {
  const [range, setRange] = useState("3M");
  const [hover, setHover] = useState(null);

  const cutoff = rangeCutoff(range);
  const closed = trades.filter(t =>
    tradeDollarPnl(t) != null && pnlDate(t) && (!cutoff || pnlDate(t) >= cutoff));

  // סכום יומי -> נקודות מצטברות לפי יום הסגירה (ראה pnlDate)
  const byDate = {};
  for (const t of closed) {
    const d = pnlDate(t);
    byDate[d] = (byDate[d] || 0) + tradeDollarPnl(t);
  }
  const dates = Object.keys(byDate).sort();
  let cum = 0;
  const points = dates.map(d => { cum += byDate[d]; return { date: d, day: byDate[d], cum }; });

  const winners = closed.filter(t => tradeDollarPnl(t) > 0).length;
  const periodPnl = points.length ? points[points.length - 1].cum : 0;

  const tiles = [
    { label: "Period P&L", value: fmtUsd(periodPnl, true), color: periodPnl > 0 ? "#4caf7d" : periodPnl < 0 ? "#e05252" : "#e8c84a" },
    { label: "Closed Trades", value: closed.length },
    { label: "Win Rate", value: closed.length ? `${Math.round((winners / closed.length) * 100)}%` : "—" },
  ];

  // גיאומטריית ה-SVG
  const W = 800, H = 300, padL = 64, padR = 20, padT = 16, padB = 34;
  const t0 = points.length ? Date.parse(points[0].date) : 0;
  const t1 = points.length ? Date.parse(points[points.length - 1].date) : 1;
  const yMin = Math.min(0, ...points.map(p => p.cum));
  const yMax = Math.max(0, ...points.map(p => p.cum));
  const ySpan = (yMax - yMin) || 1;
  const xFor = p => t1 === t0 ? (padL + (W - padL - padR) / 2)
    : padL + ((Date.parse(p.date) - t0) / (t1 - t0)) * (W - padL - padR);
  const yFor = v => padT + (1 - (v - yMin) / ySpan) * (H - padT - padB);

  const step = niceStep(ySpan);
  const yTicks = [];
  for (let v = Math.ceil(yMin / step) * step; v <= yMax + 1e-9; v += step) yTicks.push(v);

  const xLabelIdx = points.length <= 6
    ? points.map((_, i) => i)
    : Array.from({ length: 6 }, (_, i) => Math.round(i * (points.length - 1) / 5));
  const shortDate = d => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;

  const linePath = points.map((p, i) => `${i ? "L" : "M"}${xFor(p).toFixed(1)},${yFor(p.cum).toFixed(1)}`).join(" ");

  const onMove = (e) => {
    if (!points.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0, bestDist = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(xFor(p) - x);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    setHover(best);
  };

  const hp = hover != null ? points[hover] : null;
  const tooltipLeft = hp ? xFor(hp) > W - 190 : false;

  return (
    <div>
      {/* בחירת טווח זמן */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {RANGE_KEYS.map(k => (
          <Tag key={k} label={k} selected={range === k} onClick={() => { setRange(k); setHover(null); }} />
        ))}
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1,
        background: "#111", border: "1px solid #1a1a1a", borderRadius: 3, overflow: "hidden", marginBottom: 24,
      }}>
        {tiles.map(({ label, value, color }) => (
          <div key={label} style={{ padding: "14px 16px", background: "#080808" }}>
            <div style={{ fontSize: 10, color: "#888", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: color || "#e8c84a" }}>{value}</div>
          </div>
        ))}
      </div>

      {points.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px", color: "#888", fontSize: 13, letterSpacing: "0.08em" }}>
          No closed trades in this range
        </div>
      ) : (
        <div style={{ background: "#080808", border: "1px solid #1e1e1e", borderRadius: 4, padding: "18px 12px 8px" }}>
          <div style={{ fontSize: 10, color: "#888", letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 10px 14px" }}>
            Cumulative P&L ($)
          </div>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            style={{ width: "100%", display: "block", cursor: "crosshair" }}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {/* רשת + ציר Y */}
            {yTicks.map(v => (
              <g key={v}>
                <line x1={padL} x2={W - padR} y1={yFor(v)} y2={yFor(v)} stroke="#1a1a1a" strokeWidth="1" />
                <text x={padL - 8} y={yFor(v) + 3.5} textAnchor="end" fontSize="10" fill="#888"
                  fontFamily="'IBM Plex Mono', monospace">{fmtUsd(v)}</text>
              </g>
            ))}
            {/* קו האפס */}
            {yMin < 0 && yMax > 0 && (
              <line x1={padL} x2={W - padR} y1={yFor(0)} y2={yFor(0)} stroke="#444" strokeWidth="1" strokeDasharray="4 4" />
            )}
            {/* תוויות ציר X */}
            {xLabelIdx.map(i => (
              <text key={i} x={xFor(points[i])} y={H - 10} textAnchor="middle" fontSize="10" fill="#888"
                fontFamily="'IBM Plex Mono', monospace">{shortDate(points[i].date)}</text>
            ))}
            {/* הקו עצמו */}
            <path d={linePath} fill="none" stroke="#e8c84a" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {/* שכבת hover: קו אנכי + נקודה + tooltip */}
            {hp && (
              <g pointerEvents="none">
                <line x1={xFor(hp)} x2={xFor(hp)} y1={padT} y2={H - padB} stroke="#333" strokeWidth="1" />
                <circle cx={xFor(hp)} cy={yFor(hp.cum)} r="4.5" fill="#e8c84a" stroke="#080808" strokeWidth="2" />
                <g transform={`translate(${tooltipLeft ? xFor(hp) - 182 : xFor(hp) + 10}, ${Math.max(padT, Math.min(yFor(hp.cum) - 24, H - padB - 62))})`}>
                  <rect width="172" height="58" rx="3" fill="#0d0d0d" stroke="#2a2a2a" />
                  <text x="10" y="17" fontSize="10" fill="#888" fontFamily="'IBM Plex Mono', monospace">{hp.date}</text>
                  <text x="10" y="33" fontSize="11" fill="#e8e8e8" fontFamily="'IBM Plex Mono', monospace">
                    Total: {fmtUsd(hp.cum, true)}
                  </text>
                  <text x="10" y="49" fontSize="11" fill={hp.day > 0 ? "#4caf7d" : hp.day < 0 ? "#e05252" : "#888"}
                    fontFamily="'IBM Plex Mono', monospace">
                    Day: {fmtUsd(hp.day, true)}
                  </text>
                </g>
              </g>
            )}
          </svg>
        </div>
      )}
    </div>
  );
}

// טאב אנליטיקות בסגנון TradeZella: פרופיט-פקטור, ממוצעי רווח/הפסד,
// לוח שנה יומי של P&L, ופילוחים לפי יום בשבוע ולפי טיקר.
export function AnalyticsView({ trades }) {
  const [range, setRange] = useState("All");

  const cutoff = rangeCutoff(range);
  const closed = trades.filter(t =>
    tradeDollarPnl(t) != null && pnlDate(t) && (!cutoff || pnlDate(t) >= cutoff));
  const pnls = closed.map(tradeDollarPnl);

  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);
  const grossWin = wins.reduce((s, p) => s + p, 0);
  const grossLoss = -losses.reduce((s, p) => s + p, 0);
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : null;
  const avgWin = wins.length ? grossWin / wins.length : null;
  const avgLoss = losses.length ? grossLoss / losses.length : null;
  const expectancy = pnls.length ? pnls.reduce((s, p) => s + p, 0) / pnls.length : null;

  // ── זמן החזקה ממוצע ──
  // ⚠ רק דרגת exact. מיצוע של דקות מדודות יחד עם הערכות ברמת יום נותן מספר
  // חסר משמעות, ולכן טריידים בלי חותמי זמן פשוט לא נספרים כאן (והמונה למטה
  // אומר במפורש על כמה טריידים המספר מבוסס).
  const timed = closed.map(t => ({ h: holdTime(t), p: tradeDollarPnl(t) })).filter(x => x.h.tier === "exact");
  const timedWins = timed.filter(x => x.p > 0);
  const timedLosses = timed.filter(x => x.p <= 0);
  const avgOf = (arr) => arr.length ? arr.reduce((s, x) => s + x.h.minutes, 0) / arr.length : null;
  const avgHoldWin = avgOf(timedWins);
  const avgHoldLoss = avgOf(timedLosses);

  const tiles = [
    { label: "Profit Factor", value: profitFactor != null ? profitFactor.toFixed(2) : "—", color: profitFactor != null ? (profitFactor >= 1 ? "#4caf7d" : "#e05252") : undefined },
    { label: "Expectancy / Trade", value: expectancy != null ? fmtUsd(expectancy, true) : "—", color: expectancy > 0 ? "#4caf7d" : expectancy < 0 ? "#e05252" : undefined },
    { label: "Avg Win", value: avgWin != null ? fmtUsd(avgWin, true) : "—", color: "#4caf7d" },
    { label: "Avg Loss", value: avgLoss != null ? fmtUsd(-avgLoss, true) : "—", color: "#e05252" },
    {
      label: "Avg Hold W / L",
      value: timed.length
        ? <span>
            <span style={{ color: "#4caf7d" }}>{avgHoldWin != null ? fmtMinutes(avgHoldWin) : "—"}</span>
            <span style={{ color: "#555" }}> / </span>
            <span style={{ color: "#e05252" }}>{avgHoldLoss != null ? fmtMinutes(avgHoldLoss) : "—"}</span>
          </span>
        : "—",
      color: "#e8e8e8",
      caption: timed.length ? `of ${timed.length} timed trade${timed.length !== 1 ? "s" : ""}` : "no timestamps yet",
    },
  ];

  // ── פילוח לפי משך החזקה ולפי שעת כניסה ──
  const byHold = Object.fromEntries(HOLD_BUCKETS.map(b => [b.key, { pnl: 0, n: 0, wins: 0 }]));
  for (const t of closed) {
    const b = byHold[holdBucket(t)];
    const p = tradeDollarPnl(t);
    b.pnl += p; b.n += 1; if (p > 0) b.wins += 1;
  }
  const holdMax = Math.max(1, ...Object.values(byHold).map(b => Math.abs(b.pnl)));

  const byHour = HOUR_BUCKETS.map(() => ({ pnl: 0, n: 0, wins: 0 }));
  let noEntryTime = 0;
  for (const t of closed) {
    const ms = tradeInstant(t.entryAt);
    if (ms == null) { noEntryTime += 1; continue; }
    const mins = etMinutes(ms);
    const i = HOUR_BUCKETS.findIndex(b => mins >= b.lo && mins < b.hi);
    if (i < 0) { noEntryTime += 1; continue; }
    const p = tradeDollarPnl(t);
    byHour[i].pnl += p; byHour[i].n += 1; if (p > 0) byHour[i].wins += 1;
  }
  const hourMax = Math.max(1, ...byHour.map(b => Math.abs(b.pnl)));

  // ── לוח שנה יומי (מקובץ לפי יום הסגירה — ראה pnlDate) ──
  const byDate = {};
  for (const t of closed) {
    const d = pnlDate(t);
    (byDate[d] ||= { pnl: 0, count: 0 });
    byDate[d].pnl += tradeDollarPnl(t);
    byDate[d].count += 1;
  }
  const tradeMonths = [...new Set(Object.keys(byDate).map(d => d.slice(0, 7)))].sort();
  const [calMonth, setCalMonth] = useState(() => tradeMonths[tradeMonths.length - 1] || new Date().toISOString().slice(0, 7));
  const shiftMonth = (delta) => {
    const [y, m] = calMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setCalMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };
  const [cy, cm] = calMonth.split("-").map(Number);
  const firstDow = new Date(cy, cm - 1, 1).getDay();
  const daysInMonth = new Date(cy, cm, 0).getDate();
  const monthDays = Array.from({ length: daysInMonth }, (_, i) => {
    const date = `${calMonth}-${String(i + 1).padStart(2, "0")}`;
    return { day: i + 1, date, ...byDate[date] };
  });
  const monthMax = Math.max(1, ...monthDays.filter(d => d.pnl != null).map(d => Math.abs(d.pnl)));
  const monthTotal = monthDays.reduce((s, d) => s + (d.pnl || 0), 0);

  // ── יום נבחר — פתיחת רשימת הטריידים של אותו יום ──
  const [selectedDate, setSelectedDate] = useState(null);
  const selectedDayTrades = selectedDate ? closed.filter(t => pnlDate(t) === selectedDate) : [];

  const dayCell = (d) => {
    const has = d.pnl != null;
    const alpha = has ? 0.12 + 0.45 * (Math.abs(d.pnl) / monthMax) : 0;
    const bg = !has ? "#0a0a0a" : d.pnl > 0 ? `rgba(76,175,125,${alpha})` : d.pnl < 0 ? `rgba(224,82,82,${alpha})` : "#0d0d0d";
    return (
      <div key={d.day} onClick={has ? () => setSelectedDate(d.date) : undefined}
        style={{ background: bg, border: "1px solid #1a1a1a", borderRadius: 2, minHeight: 52, padding: "4px 6px", cursor: has ? "pointer" : "default" }}
        title={has ? `${d.count} trade${d.count > 1 ? "s" : ""} — click to view` : undefined}>
        <div style={{ fontSize: 9, color: "#888" }}>{d.day}</div>
        {has && (
          <div style={{ fontSize: 11, fontWeight: 600, marginTop: 4, color: d.pnl > 0 ? "#4caf7d" : d.pnl < 0 ? "#e05252" : "#888" }}>
            {fmtUsd(d.pnl, true)}
          </div>
        )}
      </div>
    );
  };

  // ── פילוחים ──
  const byWeekday = Array.from({ length: 7 }, () => 0);
  for (const [date, v] of Object.entries(byDate)) byWeekday[new Date(date + "T12:00:00").getDay()] += v.pnl;
  const weekdayMax = Math.max(1, ...byWeekday.map(Math.abs));
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const byTicker = {};
  for (const t of closed) byTicker[t.ticker] = (byTicker[t.ticker] || 0) + tradeDollarPnl(t);
  const tickers = Object.entries(byTicker).sort((a, b) => b[1] - a[1]);
  const topWinners = tickers.filter(([, v]) => v > 0).slice(0, 5);
  const topLosers = tickers.filter(([, v]) => v < 0).reverse().slice(0, 5);

  const sectionTitle = (text) => (
    <div style={{ fontSize: 10, color: "#888", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>{text}</div>
  );
  const panelStyle = { background: "#080808", border: "1px solid #1e1e1e", borderRadius: 4, padding: 16 };

  const tickerList = (list, empty) => list.length === 0
    ? <div style={{ color: "#555", fontSize: 12 }}>{empty}</div>
    : list.map(([tk, v]) => (
      <div key={tk} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid #141414", fontSize: 12 }}>
        <span style={{ color: "#e8c84a", fontWeight: 600 }}>{tk}</span>
        <span style={{ color: v > 0 ? "#4caf7d" : "#e05252", fontWeight: 600 }}>{fmtUsd(v, true)}</span>
      </div>
    ));

  // שורת עמודה אופקית משותפת. `stats` אופציונלי — כשהוא קיים מוצגים גם מספר
  // הטריידים ואחוז ההצלחה של הדלי, כמו בדוחות של TradeZella.
  const barRow = (key, label, value, max, labelW, stats, title) => (
    <div key={key} title={title}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
      <span style={{ fontSize: 10, color: stats && stats.n === 0 ? "#555" : "#888", width: labelW, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: 10, background: "#0d0d0d", borderRadius: 1, overflow: "hidden" }}>
        <div style={{
          height: "100%",
          width: `${(Math.abs(value) / max) * 100}%`,
          background: value > 0 ? "#4caf7d" : value < 0 ? "#e05252" : "transparent",
          opacity: 0.75,
        }} />
      </div>
      <span style={{ fontSize: 10, width: 64, textAlign: "right", color: value > 0 ? "#4caf7d" : value < 0 ? "#e05252" : "#555" }}>
        {stats && stats.n === 0 ? "—" : value !== 0 ? fmtUsd(value, true) : "—"}
      </span>
      {stats && (
        <>
          <span style={{ fontSize: 10, width: 30, textAlign: "right", color: stats.n ? "#888" : "#555" }}>
            {stats.n || "—"}
          </span>
          <span style={{ fontSize: 10, width: 38, textAlign: "right", color: stats.n ? "#888" : "#555" }}>
            {stats.n ? `${Math.round((stats.wins / stats.n) * 100)}%` : "—"}
          </span>
        </>
      )}
    </div>
  );

  // כותרות העמודות של דוחות הפילוח.
  const barHeader = (labelW) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 0 4px", color: "#555", fontSize: 9, letterSpacing: "0.1em" }}>
      <span style={{ width: labelW, flexShrink: 0 }} />
      <div style={{ flex: 1 }} />
      <span style={{ width: 64, textAlign: "right" }}>P&L</span>
      <span style={{ width: 30, textAlign: "right" }}>N</span>
      <span style={{ width: 38, textAlign: "right" }}>WIN</span>
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {RANGE_KEYS.map(k => (
          <Tag key={k} label={k} selected={range === k} onClick={() => setRange(k)} />
        ))}
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 1,
        background: "#111", border: "1px solid #1a1a1a", borderRadius: 3, overflow: "hidden", marginBottom: 24,
      }}>
        {tiles.map(({ label, value, color, caption }) => (
          <div key={label} style={{ padding: "14px 16px", background: "#080808" }}>
            <div style={{ fontSize: 10, color: "#888", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: color || "#e8c84a" }}>{value}</div>
            {caption && <div style={{ fontSize: 9, color: "#555", marginTop: 4 }}>{caption}</div>}
          </div>
        ))}
      </div>

      {/* לוח שנה */}
      <div style={{ ...panelStyle, marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          {sectionTitle(`Daily P&L — ${monthLabel(calMonth)}`)}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: monthTotal > 0 ? "#4caf7d" : monthTotal < 0 ? "#e05252" : "#888" }}>
              {fmtUsd(monthTotal, true)}
            </span>
            <button onClick={() => shiftMonth(-1)} style={{ background: "none", border: "1px solid #2a2a2a", color: "#aaa", borderRadius: 2, cursor: "pointer", padding: "2px 8px" }}>‹</button>
            <button onClick={() => shiftMonth(1)} style={{ background: "none", border: "1px solid #2a2a2a", color: "#aaa", borderRadius: 2, cursor: "pointer", padding: "2px 8px" }}>›</button>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 4 }}>
          {weekdayNames.map(w => (
            <div key={w} style={{ fontSize: 9, color: "#555", textAlign: "center", letterSpacing: "0.1em" }}>{w.toUpperCase()}</div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
          {Array.from({ length: firstDow }, (_, i) => <div key={`e${i}`} />)}
          {monthDays.map(dayCell)}
        </div>
      </div>

      {/* משך החזקה + שעת כניסה */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
        <div style={panelStyle}>
          {sectionTitle("Trade Duration Performance")}
          {barHeader(74)}
          {HOLD_BUCKETS.map(b => barRow(
            b.key, b.label, byHold[b.key].pnl, holdMax, 74, byHold[b.key],
            b.key === "?"
              ? "No intraday times recorded and closed the same day — the duration can't be inferred"
              : undefined,
          ))}
          <div style={{ fontSize: 9, color: "#555", marginTop: 8 }}>
            Intraday buckets use measured timestamps only. Trades held overnight are
            grouped by nights, so date-only imports land in the day buckets honestly.
          </div>
        </div>
        <div style={panelStyle}>
          {sectionTitle("Trade Time Performance")}
          {barHeader(42)}
          {HOUR_BUCKETS.map((b, i) => barRow(b.label, b.label, byHour[i].pnl, hourMax, 42, byHour[i]))}
          <div style={{ fontSize: 9, color: "#555", marginTop: 8 }}>
            By entry time, market hours (ET).
            {noEntryTime > 0 && ` ${noEntryTime} trade${noEntryTime !== 1 ? "s" : ""} excluded — no entry time recorded.`}
          </div>
        </div>
      </div>

      {/* פילוחים */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
        <div style={panelStyle}>
          {sectionTitle("P&L by Weekday")}
          {weekdayNames.slice(0, 6).map((name, i) => barRow(name, name, byWeekday[i], weekdayMax, 28))}
        </div>
        <div style={panelStyle}>
          {sectionTitle("Top Winners")}
          {tickerList(topWinners, "No winning tickers")}
        </div>
        <div style={panelStyle}>
          {sectionTitle("Top Losers")}
          {tickerList(topLosers, "No losing tickers")}
        </div>
      </div>

      {selectedDate && (
        <DayTradesModal
          date={selectedDate}
          trades={selectedDayTrades}
          onClose={() => setSelectedDate(null)}
        />
      )}
    </div>
  );
}

// מודל שמציג את כל הטריידים של יום ספציפי, נפתח בלחיצה על תא בלוח השנה.
// אותו TradeCard כמו בטאב Journal — אותו UX בדיוק — אבל תצוגה בלבד, ללא עריכה/מחיקה.
function DayTradesModal({ date, trades, onClose }) {
  const total = trades.reduce((s, t) => s + (tradeDollarPnl(t) ?? 0), 0);
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "#080808", border: "1px solid #1e1e1e", borderRadius: 4,
        width: "100%", maxWidth: 640, maxHeight: "80vh", display: "flex", flexDirection: "column",
      }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "14px 18px", borderBottom: "1px solid #1a1a1a",
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#e8e8e8", fontFamily: "'IBM Plex Mono', monospace" }}>
              {date} <span style={{ fontSize: 10, fontWeight: 400, color: "#777" }}>closed</span>
            </div>
            <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
              {trades.length} trade{trades.length !== 1 ? "s" : ""} ·{" "}
              <span style={{ color: total > 0 ? "#4caf7d" : total < 0 ? "#e05252" : "#888", fontWeight: 600 }}>
                {fmtUsd(total, true)}
              </span>
            </div>
          </div>
          <button onClick={onClose} style={{
            background: "none", border: "none", color: "#777", cursor: "pointer", fontSize: 16, padding: "0 4px",
          }}>✕</button>
        </div>
        <div style={{ overflowY: "auto", padding: "12px 18px" }}>
          {trades.map(t => (
            <TradeCard key={t.id} trade={t} />
          ))}
        </div>
      </div>
    </div>
  );
}

// טוען את כל הטריידים של המשתמש מ-Supabase, ממוין מהחדש לישן.
async function fetchTrades() {
  const { data, error } = await supabase
    .from("trades")
    .select("*")
    .order("trade_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data.map(fromRow);
}

// מיגרציה חד-פעמית: אם אין טריידים בענן ויש ב-localStorage, מעלה אותם פעם אחת.
async function migrateLocalTrades(userId, cloudCount) {
  if (localStorage.getItem(MIGRATED_KEY)) return false;
  let local = [];
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) local = JSON.parse(saved);
  } catch { /* localStorage פגום — מדלגים */ }

  if (cloudCount === 0 && Array.isArray(local) && local.length > 0) {
    const rows = local.map(t => toRow(t, userId));
    const { error } = await supabase.from("trades").insert(rows);
    if (error) throw error;
    localStorage.setItem(MIGRATED_KEY, "true");
    return true;
  }
  localStorage.setItem(MIGRATED_KEY, "true");
  return false;
}

export default function App() {
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");
  // "latest" = החודש האחרון שיש בו טריידים (ברירת מחדל), "all", או "YYYY-MM".
  const [period, setPeriod] = useState("latest");
  const [view, setView] = useState("journal");
  // הברוקר הנבחר קובע גם את הסינון וגם את התיוג של טריידים חדשים/מיובאים.
  const [broker, setBroker] = useState(() => {
    const saved = localStorage.getItem(BROKER_KEY);
    return BROKERS.includes(saved) ? saved : "IBKR";
  });

  const changeBroker = (b) => {
    setBroker(b);
    setPeriod("latest");
    localStorage.setItem(BROKER_KEY, b);
  };

  // כשמסומן, ייבוא CSV/PDF חדש ימחק קודם את כל הטריידים של הברוקר הנוכחי.
  const [resetOnImport, setResetOnImport] = useState(false);

  // מעקב אחר session: טעינה ראשונית + הקשבה לשינויי התחברות/יציאה.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // כשיש משתמש מחובר: מיגרציה (פעם אחת) ואז טעינת הטריידים מהענן.
  useEffect(() => {
    if (!session) {
      setTrades([]);
      return;
    }
    let active = true;
    (async () => {
      setLoading(true);
      setError("");
      try {
        let list = await fetchTrades();
        const migrated = await migrateLocalTrades(session.user.id, list.length);
        if (migrated) list = await fetchTrades();
        if (active) setTrades(list);
      } catch (e) {
        if (active) setError(e.message || "Error loading trades");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [session]);

  const handleNew = () => {
    setEditing(emptyTrade(broker));
    setShowForm(true);
  };

  const handleEdit = (trade) => {
    setEditing({ ...trade });
    setShowForm(true);
  };

  const handleChange = (field, value) => {
    setEditing(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    if (!editing || !session) return;
    setSaving(true);
    setError("");
    try {
      const row = toRow(editing, session.user.id);
      if (editing.id) {
        const { data, error } = await supabase
          .from("trades")
          .update(row)
          .eq("id", editing.id)
          .select()
          .single();
        if (error) throw error;
        const saved = fromRow(data);
        setTrades(prev => prev.map(t => (t.id === saved.id ? saved : t)));
      } else {
        const { data, error } = await supabase
          .from("trades")
          .insert(row)
          .select()
          .single();
        if (error) throw error;
        setTrades(prev => [fromRow(data), ...prev]);
      }
      setShowForm(false);
      setEditing(null);
    } catch (e) {
      setError(e.message || "Error saving trade");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    const prev = trades;
    setTrades(prev.filter(t => t.id !== id)); // עדכון אופטימי
    const { error } = await supabase.from("trades").delete().eq("id", id);
    if (error) {
      setError(error.message);
      setTrades(prev); // החזרה למצב הקודם אם נכשל
    }
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(trades, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trade-journal-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!Array.isArray(data)) { alert("Invalid file"); return; }
        // ⚠ externalId מכוון מוסר: קובץ שיוצא מהאפליקציה נושא אותו, וניסיון
        // להכניס אותו שוב היה מתנגש עם trades_user_external_uidx ומפיל את כל
        // האצווה. שחזור אמור ליצור שורות חדשות ועצמאיות.
        const rows = data.map(({ externalId, ...t }) => toRow(t, session.user.id));
        const { error } = await supabase.from("trades").insert(rows);
        if (error) throw error;
        setTrades(await fetchTrades());
      } catch (err) { alert("Import error: " + (err.message || "Invalid file")); }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // Deterministic ids from trade content, so re-importing the same export (or an
  // overlapping window) can't create duplicate rows — matches the DayTrade bot's
  // approach (see schema.sql). Same content -> same id -> upsert skips it.
  //
  // ⚠ Computed for the whole batch at once because two genuinely different round
  // trips can share every content field — scalping the same setup twice in a day
  // gives identical ticker/size/prices. Before the IBKR parser split same-day
  // cycles apart those were averaged into one row and the clash couldn't arise;
  // now it can, and without the suffix the upsert would silently drop the second
  // trade. Repeats get "#2", "#3"…; the first keeps the bare key so ids stay
  // stable for the overwhelming majority of trades.
  //
  // Commission is deliberately NOT part of the key — it isn't an identity
  // attribute, and a broker restating it would otherwise orphan the row.
  // ⚠ The account segment is appended ONLY when the parser supplied one (IBKR).
  // Adding an empty segment unconditionally would change the key shape for IBI
  // and Blink too, orphaning every row they already have and turning the next
  // re-import into a pile of duplicates.
  //
  // Why the account matters: two IBKR accounts running the same signals produce
  // trades identical in ticker, date, size and both prices. Without it the second
  // account's row is skipped as a duplicate and vanishes with no error — and the
  // "#N" counter can't save it, because it restarts on every import and so never
  // sees the other file's rows.
  const externalIdsFor = (parsedTrades, broker) => {
    const seen = new Map();
    return parsedTrades.map(t => {
      const key = [broker];
      if (t.account) key.push(t.account);
      key.push(t.date, t.ticker, t.quantity, t.entryPrice, t.exitPrice);
      const base = key.join("|");
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      return n === 1 ? base : `${base}#${n}`;
    });
  };

  const handleImportFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const imp = IMPORTERS[broker];
    if (!imp) return;
    if (resetOnImport) {
      const ok = window.confirm(
        `This will delete ALL existing ${broker} trades before importing.\nThis cannot be undone. Continue?`
      );
      if (!ok) { e.target.value = ""; return; }
    }
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const parsed = await imp.parse(ev.target.result);
        if (parsed.length === 0) {
          alert("No Buy/Sell transactions found in this file.");
          return;
        }
        if (resetOnImport) {
          const { error: delError } = await supabase.from("trades").delete().eq("broker", broker);
          if (delError) throw delError;
        }
        const extIds = externalIdsFor(parsed, broker);
        const rows = parsed.map((t, i) =>
          toRow({ ...t, broker, externalId: extIds[i] }, session.user.id)
        );
        const { data, error } = await supabase
          .from("trades")
          .upsert(rows, { onConflict: "user_id,external_id", ignoreDuplicates: true })
          .select("id");
        if (error) throw error;

        const imported = data ? data.length : parsed.length;
        const skipped = parsed.length - imported;

        // ── מילוי לאחור של עמודות שנוספו אחרי הייבוא הראשון ──
        // ignoreDuplicates לא מעדכן שורות קיימות, ו-external_id לא כולל את
        // exit_date / entry_at / exit_at / commission — כך שטריידים שיובאו לפני
        // שהעמודות האלה נוספו היו נשארים ריקים לנצח גם אחרי ייבוא חוזר.
        //
        // מעדכנים רק את העמודות האלה, ורק היכן שהן NULL, כדי שלקחים והערות
        // שנכתבו ידנית — וגם תיקון ידני של ערך — לא יידרסו.
        //
        // ארבעה שומרים מדורגים:
        //   1. skipped > 0        — בייבוא נקי כל שורה נכתבה מלאה ממילא.
        //   2. תצלום ה-trades שלפני הייבוא — מדלגים על שורות שכבר מלאות, כך
        //      שייבוא חוזר של קובץ שכבר מולא לא שולח ולו בקשה אחת.
        //   3. .is(col, null) בצד השרת — התצלום עלול להיות לא עדכני (מכשיר אחר).
        //   4. רק שורות שבאמת חסר בהן משהו נכנסות ל-patches.
        let backfilled = 0;
        if (skipped > 0) {
          const existing = new Map(trades.filter(t => t.externalId).map(t => [t.externalId, t]));
          const patches = [];
          parsed.forEach((t, i) => {
            const cur = existing.get(extIds[i]);
            if (!cur) return;                       // חדש — נכתב מלא בשורה למעלה
            const patch = {};
            if (t.exitDate && !cur.exitDate) patch.exit_date = t.exitDate;
            if (t.entryAt && !cur.entryAt) patch.entry_at = t.entryAt;
            if (t.exitAt && !cur.exitAt) patch.exit_at = t.exitAt;
            if (t.commission && !cur.commission) patch.commission = Number(t.commission);
            if (Object.keys(patch).length) patches.push({ extId: extIds[i], patch });
          });

          const CONC = 6;   // מקביליות צנועה: מהיר בהרבה מסדרתי, הרחק מכל מגבלת קצב
          for (let i = 0; i < patches.length; i += CONC) {
            const res = await Promise.all(patches.slice(i, i + CONC).map(({ extId, patch }) =>
              supabase.from("trades")
                .update(patch)
                .eq("broker", broker)
                .eq("external_id", extId)
                .is(Object.keys(patch)[0], null)
                .select("id")
            ));
            for (const { data: upd, error: e2 } of res) {
              if (e2) throw e2;
              backfilled += upd ? upd.length : 0;
            }
          }
        }

        setTrades(await fetchTrades());
        alert(
          `Imported ${imported} trade${imported !== 1 ? "s" : ""} from ${broker} ${imp.label}` +
          (skipped > 0 ? ` (${skipped} duplicate${skipped !== 1 ? "s" : ""} skipped).` : ".") +
          (backfilled > 0 ? `\nFilled in missing details on ${backfilled} existing trade${backfilled !== 1 ? "s" : ""}.` : "") +
          `\nEntry/exit prices are pre-filled — add your notes, lessons and setup type manually.`
        );
      } catch (err) {
        alert("Import error: " + (err.message || "Invalid file"));
      }
    };
    if (imp.binary) reader.readAsArrayBuffer(file); else reader.readAsText(file);
    e.target.value = "";
  };

  // מוחק את כל הטריידים של הברוקר הנבחר בלבד — לא תלוי בייבוא, למקרה של כפילויות
  // שהצטברו (למשל אחרי כמה ייבואים חופפים) שרוצים לנקות ולהתחיל מחדש.
  const handleResetBroker = async () => {
    const count = trades.filter(t => (t.broker || "IBKR") === broker).length;
    if (count === 0) return;
    const ok = window.confirm(
      `This will permanently delete ALL ${count} ${broker} trade${count !== 1 ? "s" : ""}.\nThis cannot be undone. Continue?`
    );
    if (!ok) return;
    const prev = trades;
    setTrades(prev.filter(t => (t.broker || "IBKR") !== broker)); // עדכון אופטימי
    const { error } = await supabase.from("trades").delete().eq("broker", broker);
    if (error) {
      setError(error.message);
      setTrades(prev); // החזרה למצב הקודם אם נכשל
    }
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditing(null);
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setShowForm(false);
    setEditing(null);
  };

  if (!authReady) return null;
  if (!session) return <Login />;

  // מסננים קודם לפי ברוקר, ואז נגזרים החודשים והסינון החודשי.
  const brokerTrades = trades.filter(t => (t.broker || "IBKR") === broker);
  const months = [...new Set(brokerTrades.map(t => (t.date || "").slice(0, 7)).filter(m => m.length === 7))]
    .sort()
    .reverse();
  const effectivePeriod = period === "latest" ? (months[0] || "all") : period;
  const visibleTrades = effectivePeriod === "all"
    ? brokerTrades
    : brokerTrades.filter(t => (t.date || "").startsWith(effectivePeriod));

  const btnStyle = {
    padding: "10px 16px",
    background: "none",
    border: "1px solid #2a2a2a",
    borderRadius: 2,
    color: "#555",
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 12,
    cursor: "pointer",
    letterSpacing: "0.08em",
  };

  return (
    <div dir="ltr" style={{
      minHeight: "100vh",
      background: "#050505",
      color: "#f0f0f0",
      padding: "0",
      fontFamily: "'IBM Plex Mono', monospace",
    }}>
      <style>{`
        input::placeholder { color: #e8e8e8; opacity: 1; }
        textarea::placeholder { color: #e8e8e8; opacity: 1; }
      `}</style>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{
        borderBottom: "1px solid #1a1a1a",
        padding: "20px 32px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        background: "#030303",
      }}>
        <div>
          <div style={{
            fontSize: 11,
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            color: "#999",
            marginBottom: 4,
          }}>Trade Journal</div>
          <div style={{
            fontSize: 20,
            fontWeight: 700,
            color: "#e8c84a",
            letterSpacing: "0.05em",
          }}>Lessons Learned</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* Import JSON */}
          <label style={btnStyle}>
            ↑ Import
            <input type="file" accept=".json" onChange={handleImport} style={{ display: "none" }} />
          </label>
          {/* Broker selector — controls which trades are shown and how imports are tagged */}
          <select
            value={broker}
            onChange={e => changeBroker(e.target.value)}
            title="Broker"
            style={{ ...btnStyle, color: "#7aaacc", background: "#030303", outline: "none" }}
          >
            {BROKERS.map(b => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
          {/* Reset — deletes all trades for the selected broker (e.g. to clear duplicates and re-import clean) */}
          <button
            onClick={handleResetBroker}
            title={`Delete ALL ${broker} trades`}
            style={{ ...btnStyle, color: "#c96a6a" }}
          >⨯ Reset {broker}</button>
          {/* File import — shown only for brokers we have a parser for */}
          {IMPORTERS[broker] && (
            <>
              <label
                style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#888", cursor: "pointer" }}
                title={`Delete all existing ${broker} trades before the next import`}
              >
                <input
                  type="checkbox"
                  checked={resetOnImport}
                  onChange={e => setResetOnImport(e.target.checked)}
                />
                Reset
              </label>
              <label style={{ ...btnStyle, color: "#7aaacc" }} title={`Import ${broker} transaction-history ${IMPORTERS[broker].label}`}>
                ↑ {IMPORTERS[broker].label}
                <input type="file" accept={IMPORTERS[broker].accept} onChange={handleImportFile} style={{ display: "none" }} />
              </label>
            </>
          )}
          {/* Export */}
          <button onClick={handleExport} style={btnStyle}>↓ Export</button>
          {/* Sign out */}
          <button onClick={handleSignOut} style={btnStyle} title={session.user.email}>Sign Out</button>
          <button onClick={handleNew} style={{
            padding: "10px 22px",
            background: "#e8c84a",
            border: "none",
            borderRadius: 2,
            color: "#000",
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
            letterSpacing: "0.1em",
          }}>+ New Trade</button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 26, padding: "12px 32px 0", borderBottom: "1px solid #1a1a1a", background: "#030303" }}>
        {[["journal", "Journal"], ["performance", "Performance"], ["analytics", "Analytics"]].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            style={{
              background: "none",
              border: "none",
              borderBottom: view === key ? "2px solid #e8c84a" : "2px solid transparent",
              color: view === key ? "#e8c84a" : "#888",
              padding: "2px 2px 10px",
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 12,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >{label}</button>
        ))}
      </div>

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "28px 32px" }}>
        {error && (
          <div style={{
            border: "1px solid #3d1e1e",
            background: "#1a0a0a",
            color: "#e05252",
            padding: "10px 14px",
            borderRadius: 3,
            fontSize: 12,
            marginBottom: 16,
          }}>{error}</div>
        )}

        {view === "performance" && <PerformanceView trades={brokerTrades} />}
        {view === "analytics" && <AnalyticsView trades={brokerTrades} />}

        {view === "journal" && <>
        {months.length > 0 && <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
          <select
            value={effectivePeriod}
            onChange={e => setPeriod(e.target.value)}
            style={{
              background: "#0d0d0d",
              border: "1px solid #2a2a2a",
              borderRadius: 2,
              padding: "7px 10px",
              color: "#e8e8e8",
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 12,
              letterSpacing: "0.05em",
              outline: "none",
              cursor: "pointer",
            }}
          >
            {months.map(m => (
              <option key={m} value={m}>{monthLabel(m)}</option>
            ))}
            <option value="all">All time</option>
          </select>
        </div>}

        <Stats trades={visibleTrades} />

        {/* טופס טרייד חדש נפתח למעלה; עריכה נפתחת במקום הכרטיס עצמו ברשימה. */}
        {showForm && editing && !editing.id && (
          <div style={{ marginBottom: 24 }}>
            <TradeForm
              trade={editing}
              onChange={handleChange}
              onSave={handleSave}
              onCancel={handleCancel}
              saving={saving}
            />
          </div>
        )}

        {loading && (
          <div style={{ textAlign: "center", padding: "40px 20px", color: "#2a2a2a", fontSize: 13, letterSpacing: "0.08em" }}>
            Loading...
          </div>
        )}

        {!loading && visibleTrades.length === 0 && !showForm && (
          <div style={{
            textAlign: "center",
            padding: "60px 20px",
            color: "#cccccc",
            fontSize: 13,
            letterSpacing: "0.08em",
          }}>
            No trades yet — add your first one
          </div>
        )}

        {visibleTrades.map(t => (
          showForm && editing && editing.id === t.id ? (
            <div key={t.id} style={{ marginBottom: 10 }}>
              <TradeForm
                trade={editing}
                onChange={handleChange}
                onSave={handleSave}
                onCancel={handleCancel}
                saving={saving}
              />
            </div>
          ) : (
            <TradeCard key={t.id} trade={t} onEdit={handleEdit} onDelete={handleDelete} />
          )
        ))}
        </>}
      </div>
    </div>
  );
}
