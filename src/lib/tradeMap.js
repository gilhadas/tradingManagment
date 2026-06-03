// ממיר בין מבנה הטרייד של ה-UI (camelCase) לעמודות הטבלה ב-Supabase (snake_case).

// מחרוזת ריקה / לא-מספר -> null, אחרת מספר. שומר על numeric נקי בבסיס הנתונים.
const toNum = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};

// numeric מה-DB -> מחרוזת ל-input מבוקר (או "" כשאין ערך).
const toStr = (v) => (v === null || v === undefined ? "" : String(v));

// trade (UI) -> row (DB). user_id מצורף בנפרד כי הוא מגיע מה-session.
export function toRow(trade, userId) {
  return {
    user_id: userId,
    trade_date: trade.date || null,
    ticker: trade.ticker || null,
    direction: trade.direction || null,
    setup_type: trade.setupType || null,
    catalyst: trade.catalyst || null,
    entry_price: toNum(trade.entryPrice),
    stop_price: toNum(trade.stopPrice),
    exit_price: toNum(trade.exitPrice),
    pnl: toNum(trade.pnl),
    emotion_entry: trade.emotionEntry || null,
    mistakes: trade.mistakes || [],
    what_went_right: trade.whatWentRight || null,
    what_went_wrong: trade.whatWentWrong || null,
    lesson: trade.lesson || null,
    would_retake: trade.wouldRetake,
  };
}

// row (DB) -> trade (UI). שומר על אותו מבנה שהקומפוננטות מצפות לו.
export function fromRow(row) {
  return {
    id: row.id,
    date: row.trade_date || "",
    ticker: row.ticker || "",
    direction: row.direction || "Long",
    setupType: row.setup_type || "",
    catalyst: row.catalyst || "",
    entryPrice: toStr(row.entry_price),
    stopPrice: toStr(row.stop_price),
    exitPrice: toStr(row.exit_price),
    pnl: toStr(row.pnl),
    emotionEntry: row.emotion_entry || "",
    mistakes: row.mistakes || [],
    whatWentRight: row.what_went_right || "",
    whatWentWrong: row.what_went_wrong || "",
    lesson: row.lesson || "",
    wouldRetake: row.would_retake,
  };
}
