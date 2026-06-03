import { useState } from "react";
import { supabase } from "../lib/supabase";

export default function Login() {
  const [error, setError] = useState("");

  const signIn = async () => {
    setError("");
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) setError(error.message);
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#050505",
        color: "#f0f0f0",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'IBM Plex Mono', monospace",
      }}
    >
      <style>{`
        input::placeholder { color: #e8e8e8; opacity: 1; }
      `}</style>
      <link
        href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&display=swap"
        rel="stylesheet"
      />
      <div
        style={{
          background: "#080808",
          border: "1px solid #1e1e1e",
          borderRadius: 4,
          padding: "40px 36px",
          width: 340,
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontSize: 11,
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            color: "#333",
            marginBottom: 6,
          }}
        >
          Trade Journal
        </div>
        <div
          style={{
            fontSize: 22,
            fontWeight: 700,
            color: "#e8c84a",
            letterSpacing: "0.05em",
            marginBottom: 28,
          }}
        >
          הפקת לקחים
        </div>
        <button
          onClick={signIn}
          style={{
            width: "100%",
            padding: "12px 18px",
            background: "#e8c84a",
            border: "none",
            borderRadius: 2,
            color: "#000",
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
            letterSpacing: "0.08em",
          }}
        >
          התחבר עם Google
        </button>
        <div
          style={{
            fontSize: 10,
            color: "#444",
            marginTop: 18,
            letterSpacing: "0.06em",
            lineHeight: 1.6,
          }}
        >
          הנתונים שלך מסונכרנים בין כל המכשירים
        </div>
        {error && (
          <div style={{ color: "#e05252", fontSize: 11, marginTop: 16 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
