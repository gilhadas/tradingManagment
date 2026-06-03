# Trade Journal — הפקת לקחים

יומן מסחר ב-React עם backend ב-Supabase, התחברות Google, וסנכרון בין מכשירים.

## Stack
- **React 18 + Vite** — frontend
- **Supabase** — database + Auth (Google OAuth) עם Row Level Security
- **Vercel** — hosting

---

## הקמה מקומית

### 1. Supabase — יצירת פרויקט וסכמה
1. היכנס ל-[supabase.com](https://supabase.com) → **New project**. בחר שם וסיסמה ל-DB.
2. כשהפרויקט מוכן: **Project Settings → API**. העתק:
   - `Project URL` → `VITE_SUPABASE_URL`
   - `anon` `public` key → `VITE_SUPABASE_ANON_KEY`
3. **SQL Editor → New query** → הדבק את תוכן [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
   זה יוצר את טבלת `trades` עם RLS (כל משתמש רואה רק את הנתונים שלו).

### 2. Google OAuth
1. [Google Cloud Console](https://console.cloud.google.com) → צור פרויקט (או בחר קיים).
2. **APIs & Services → OAuth consent screen** → הגדר אפליקציה (External), הוסף את כתובת המייל שלך ל-Test users.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - **Authorized redirect URIs**: `https://<PROJECT-REF>.supabase.co/auth/v1/callback`
     (את `<PROJECT-REF>` מוצאים ב-URL של הפרויקט ב-Supabase)
4. העתק את **Client ID** ו-**Client Secret**.
5. ב-Supabase: **Authentication → Providers → Google** → הפעל, הדבק Client ID + Secret → **Save**.

### 3. משתני סביבה
```bash
cp .env.example .env.local
```
ערוך את `.env.local` והכנס את הערכים משלב 1.

### 4. הרצה
```bash
npm install
npm run dev
```
פתח את הכתובת שמודפסת (בד״כ `http://localhost:5173`).
בהתחברות הראשונה עם Google, אם יש טריידים שמורים ב-`localStorage` של הדפדפן הזה — הם יועלו אוטומטית פעם אחת.

---

## Deploy ל-Vercel

1. העלה את הקוד ל-GitHub:
   ```bash
   git init
   git add -A
   git commit -m "Trade Journal with Supabase backend"
   git branch -M main
   git remote add origin https://github.com/<USER>/<REPO>.git
   git push -u origin main
   ```
2. ב-[vercel.com](https://vercel.com) → **Add New → Project** → ייבא את ה-repo.
   Vercel מזהה Vite אוטומטית (Build: `vite build`, Output: `dist`).
3. **Environment Variables** — הוסף:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. **Deploy**.
5. אחרי שיש דומיין (`https://<app>.vercel.app`), עדכן ב-Supabase:
   **Authentication → URL Configuration**:
   - **Site URL**: `https://<app>.vercel.app`
   - **Redirect URLs**: הוסף `https://<app>.vercel.app` (וגם `http://localhost:5173` לפיתוח)

   ללא הצעד הזה ההתחברות מהדומיין החי תיכשל / תחזיר לכתובת הלא-נכונה.

---

## מבנה הפרויקט
```
src/
  App.jsx              # הרכיב הראשי — UI + שכבת נתונים מול Supabase
  main.jsx             # entry point
  components/Login.jsx # מסך התחברות Google
  lib/supabase.js      # אתחול לקוח Supabase מ-env
  lib/tradeMap.js      # המרה בין מבנה ה-UI לעמודות ה-DB
supabase/schema.sql    # סכמת הטבלה + מדיניות RLS
```

## הערות אבטחה
- ה-`anon key` נועד לרוץ בצד הלקוח — הוא בטוח לחשיפה. ההגנה האמיתית היא ב-RLS:
  המדיניות ב-`schema.sql` מבטיחה שכל משתמש ניגש אך ורק לשורות שבהן `user_id = auth.uid()`.
- אל תכניס לעולם את ה-`service_role` key ל-frontend.
