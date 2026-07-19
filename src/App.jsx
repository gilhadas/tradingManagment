import { useState, useEffect } from "react";
import { supabase } from "./lib/supabase";
import { toRow, fromRow } from "./lib/tradeMap";
import { parseIBKRCsv } from "./lib/ibkrParser";
import Login from "./components/Login";

const STORAGE_KEY = "trade_journal_v1";
const MIGRATED_KEY = "trade_journal_migrated";

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

// רווח/הפסד בדולרים: כמות × (יציאה − כניסה), הפוך לשורט. null אם חסר ערך.
const tradeDollarPnl = (t) => {
  const qty = parseFloat(t.quantity);
  const entry = parseFloat(t.entryPrice);
  const exit = parseFloat(t.exitPrice);
  if (isNaN(qty) || isNaN(entry) || isNaN(exit)) return null;
  return (t.direction === "Short" ? entry - exit : exit - entry) * qty;
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

const emptyTrade = () => ({
  date: new Date().toISOString().slice(0, 10),
  ticker: "",
  direction: "Long",
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
    <span style={{
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

  return (
    <div style={{
      border: `1px solid ${borderColor}`,
      borderLeft: `3px solid ${isNaN(pnl) ? "#444" : pnl > 0 ? "#4caf7d" : "#e05252"}`,
      borderRadius: 3,
      padding: "14px 16px",
      marginBottom: 10,
      background: "#0a0a0a",
      cursor: "pointer",
    }} onClick={() => onEdit(trade)}>
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
          <button onClick={e => { e.stopPropagation(); onDelete(trade.id); }} style={{
            background: "none", border: "none", color: "#777", cursor: "pointer", fontSize: 14, padding: "0 4px"
          }}>✕</button>
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
  const posValue = tradePositionValue(trade);

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
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 16 }}>
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
    setEditing(emptyTrade());
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
        const rows = data.map(t => toRow(t, session.user.id));
        const { error } = await supabase.from("trades").insert(rows);
        if (error) throw error;
        setTrades(await fetchTrades());
      } catch (err) { alert("Import error: " + (err.message || "Invalid file")); }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleImportIBKR = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const parsed = parseIBKRCsv(ev.target.result);
        if (parsed.length === 0) {
          alert("No Buy/Sell transactions found in this file.");
          return;
        }
        const rows = parsed.map(t => toRow(t, session.user.id));
        const { error } = await supabase.from("trades").insert(rows);
        if (error) throw error;
        setTrades(await fetchTrades());
        alert(`Imported ${parsed.length} trade${parsed.length !== 1 ? "s" : ""} from IBKR CSV.\nEntry/exit prices are pre-filled — add your notes, lessons and setup type manually.`);
      } catch (err) {
        alert("Import error: " + (err.message || "Invalid file"));
      }
    };
    reader.readAsText(file);
    e.target.value = "";
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

  // חודשים ייחודיים מתוך הטריידים, מהחדש לישן; ברירת המחדל היא האחרון שבהם.
  const months = [...new Set(trades.map(t => (t.date || "").slice(0, 7)).filter(m => m.length === 7))]
    .sort()
    .reverse();
  const effectivePeriod = period === "latest" ? (months[0] || "all") : period;
  const visibleTrades = effectivePeriod === "all"
    ? trades
    : trades.filter(t => (t.date || "").startsWith(effectivePeriod));

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
          {/* Import IBKR CSV */}
          <label style={{ ...btnStyle, color: "#7aaacc" }} title="Import IBKR Transaction History CSV">
            ↑ IBKR
            <input type="file" accept=".csv" onChange={handleImportIBKR} style={{ display: "none" }} />
          </label>
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
      </div>
    </div>
  );
}
