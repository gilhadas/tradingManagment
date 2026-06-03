import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // עוזר לאבחן הגדרת env חסרה במקום כשל שקט מאוחר יותר
  console.error(
    "Missing Supabase env vars. צור קובץ .env.local עם VITE_SUPABASE_URL ו-VITE_SUPABASE_ANON_KEY (ראה .env.example)."
  );
}

export const supabase = createClient(url, anonKey);
