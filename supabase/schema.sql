-- הרץ קובץ זה ב-Supabase → SQL Editor (פעם אחת).
-- יוצר את טבלת הטריידים עם Row Level Security כך שכל משתמש רואה רק את הנתונים שלו.

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  trade_date date,
  ticker text,
  direction text,
  setup_type text,
  catalyst text,
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
