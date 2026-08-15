-- הרץ קובץ זה ב-Supabase → SQL Editor (פעם אחת).
-- יוצר את טבלת הטריידים עם Row Level Security כך שכל משתמש רואה רק את הנתונים שלו.

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  trade_date date,
  ticker text,
  direction text,
  broker text,
  setup_type text,
  catalyst text,
  quantity numeric,
  entry_price numeric,
  stop_price numeric,
  exit_price numeric,
  pnl numeric,
  emotion_entry text,
  mistakes text[] default '{}',
  what_went_right text,
  what_went_wrong text,
  lesson text,
  would_retake boolean,
  created_at timestamptz default now()
);

-- אינדקס לטעינה מהירה של טריידים לפי משתמש ותאריך
create index if not exists trades_user_date_idx
  on public.trades (user_id, trade_date desc);

-- מזהה חיצוני לסנכרון אוטומטי (בוט DayTrade -> journal_sync.py).
-- The bot derives external_id from the trade's CONTENT and upserts with
-- `?on_conflict=user_id,external_id&Prefer: resolution=ignore-duplicates`, so a
-- re-run or a restored backup can never create duplicate rows.
alter table public.trades add column if not exists external_id text;

-- Deliberately NOT a partial index: PostgREST's ?on_conflict= cannot infer a
-- conflict target against `where external_id is not null`. Postgres treats NULLs
-- as distinct, so every manually-entered row (external_id null) is unaffected.
create unique index if not exists trades_user_external_uidx
  on public.trades (user_id, external_id);

-- תאריך הסגירה בפועל של הפוזיציה. `trade_date` משמש בברוקרים שונים באופן לא
-- אחיד — יבוא CSV/PDF מתעד בו את תאריך הפתיחה (posDate), ואילו הבוט DayTrade
-- מתעד בו את תאריך הסגירה (journal_sync.py:_trade_date) — כך שלוח השנה מקבץ
-- לפי תאריכים שונים בין ברוקרים. עמודה נפרדת נותנת לכל טרייד גם את תאריך
-- הסגירה בפועל, ללא תלות באיך `trade_date` מחושב עבור הברוקר שלו.
alter table public.trades add column if not exists exit_date date;

-- חותמי הזמן המדויקים של הכניסה והיציאה, לחישוב משך החזקה ופילוח לפי שעת
-- כניסה. nullable בכוונה: ל-IBKR CSV ול-Blink PDF אין שעה במקור ולא תהיה,
-- ולכן NULL פירושו "לא נרשם" ולעולם לא "אפס". IBI נושא HH:MM:SS עם קיצור אזור
-- זמן (EDT/EST), והבוט DayTrade נושא ISO-8601 ב-UTC.
alter table public.trades add column if not exists entry_at timestamptz;
alter table public.trades add column if not exists exit_at  timestamptz;

-- עמלה כוללת לסבב המסחר, כערך חיובי (הברוקרים מדווחים אותה שלילית). מסוכמת
-- לאורך הפוזיציה ומחולקת יחסית כשפוזיציה נסגרת בחלקים. ה-P&L הדולרי באפליקציה
-- הוא נטו — כלומר בניכוי העמודה הזו. NULL = לא נרשם, ומתנהג כאפס.
alter table public.trades add column if not exists commission numeric;

alter table public.trades enable row level security;

-- מדיניות גישה: משתמש מחובר ניגש אך ורק לשורות שלו
create policy "trades_select" on public.trades
  for select using (auth.uid() = user_id);

create policy "trades_insert" on public.trades
  for insert with check (auth.uid() = user_id);

create policy "trades_update" on public.trades
  for update using (auth.uid() = user_id);

create policy "trades_delete" on public.trades
  for delete using (auth.uid() = user_id);
