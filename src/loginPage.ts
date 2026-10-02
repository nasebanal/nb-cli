/**
 * The page the browser lands on after `nb auth login` (the loopback redirect).
 *
 * Self-contained on purpose: one HTML string, inline CSS, the logo as a data
 * URI, no script and no external request — it is served by a throwaway server
 * on 127.0.0.1 and must work offline and under a strict CSP. Everything that
 * comes from the URL (the OAuth `error` / `error_description`) is escaped:
 * anything can send the browser to http://localhost:<port>/callback?error=…
 */
import { LOGO_PNG_BASE64 } from "./logo.js";

export type PageLang = "ja" | "en";

/** `ja` when the browser prefers Japanese, else English. */
export function pickLang(acceptLanguage: string | undefined): PageLang {
  const first = (acceptLanguage ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("ja") ? "ja" : "en";
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const COPY = {
  en: {
    okTitle: "Logged in",
    okLead: "You can close this tab and return to your terminal.",
    okHint: "Check it with",
    errTitle: "Login failed",
    errLead: "Return to your terminal and run the login again.",
    errHint: "Try again with",
    detail: "Details",
  },
  ja: {
    okTitle: "ログインしました",
    okLead: "このタブを閉じて、ターミナルに戻ってください。",
    okHint: "次のコマンドで確認できます",
    errTitle: "ログインに失敗しました",
    errLead: "ターミナルに戻って、もう一度ログインしてください。",
    errHint: "もう一度ログインするには",
    detail: "詳細",
  },
} as const;

const CHECK_ICON = `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const CROSS_ICON = `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>`;

const STYLE = `
:root{color-scheme:light dark;--bg:#f3f6fa;--bg2:#dfeaf5;--card:#fff;--fg:#1b2430;--muted:#5c6b7d;--line:#e2e8f0;--accent:#2f8fc7;--ok:#1f9d63;--okbg:#e3f6ec;--err:#c8423a;--errbg:#fde8e6;--code:#f1f5f9}
@media (prefers-color-scheme:dark){.logo{background:#fff;border-radius:50%;padding:3px;width:76px;height:76px}:root{--bg:#0e141b;--bg2:#15202c;--card:#18212b;--fg:#e6ebf1;--muted:#97a4b4;--line:#263241;--accent:#5cb6e6;--ok:#4cc38a;--okbg:#14301f;--err:#f0766d;--errbg:#3a1a18;--code:#0f1720}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.25rem;padding:1.5rem 1rem;background:linear-gradient(160deg,var(--bg) 0%,var(--bg2) 100%);color:var(--fg);font-family:system-ui,-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif;line-height:1.6}
.card{width:100%;max-width:26rem;background:var(--card);border:1px solid var(--line);border-radius:1.25rem;padding:2.25rem 2rem 2rem;text-align:center;box-shadow:0 18px 50px -24px rgba(15,35,60,.35)}
.logo{width:72px;height:72px;display:block;margin:0 auto .5rem}
.brand{margin:0 0 1.5rem;font-size:.8rem;font-weight:700;letter-spacing:.18em;color:var(--muted)}
.status{width:4rem;height:4rem;margin:0 auto 1.1rem;border-radius:50%;display:flex;align-items:center;justify-content:center}
.status.ok{background:var(--okbg);color:var(--ok)}
.status.err{background:var(--errbg);color:var(--err)}
h1{margin:0 0 .5rem;font-size:1.5rem;line-height:1.3}
.lead{margin:0 0 1.5rem;color:var(--muted);text-wrap:balance;word-break:auto-phrase}
.hint{display:flex;flex-direction:column;gap:.35rem;align-items:center;padding:.9rem 1rem;border-radius:.75rem;background:var(--code);border:1px solid var(--line);font-size:.85rem;color:var(--muted)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.95rem;color:var(--fg);overflow-wrap:anywhere}
.detail{margin:1rem 0 0;font-size:.8rem;color:var(--muted);text-align:left;overflow-wrap:anywhere}
.detail code{font-size:.8rem}
footer{font-size:.8rem;color:var(--muted)}
footer a{color:var(--accent);text-decoration:none}
footer a:hover{text-decoration:underline}
`;

export interface PageOptions {
  ok: boolean;
  lang: PageLang;
  /** OAuth `error` / `error_description` for a failed login; escaped here. */
  error?: string;
}

/** Longest OAuth error text we echo back, so a crafted URL cannot fill the page. */
const MAX_DETAIL = 200;

export function renderLoginPage({ ok, lang, error }: PageOptions): string {
  const t = COPY[lang];
  const title = ok ? t.okTitle : t.errTitle;
  const lead = ok ? t.okLead : t.errLead;
  const hint = ok ? t.okHint : t.errHint;
  const command = ok ? "nb auth status" : "nb auth login";
  const detail =
    !ok && error
      ? `<p class="detail">${t.detail}: <code>${escapeHtml(error.slice(0, MAX_DETAIL))}</code></p>`
      : "";

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · NASEBANAL CLI</title>
<style>${STYLE}</style>
</head>
<body>
<main class="card">
<img class="logo" src="data:image/png;base64,${LOGO_PNG_BASE64}" width="72" height="72" alt="NASEBANAL">
<p class="brand">NASEBANAL CLI</p>
<div class="status ${ok ? "ok" : "err"}" role="img" aria-label="${ok ? "success" : "error"}">${ok ? CHECK_ICON : CROSS_ICON}</div>
<h1>${escapeHtml(title)}</h1>
<p class="lead">${escapeHtml(lead)}</p>
<div class="hint"><span>${escapeHtml(hint)}</span><code>${command}</code></div>
${detail}
</main>
<footer><a href="https://www.nasebanal.com">nasebanal.com</a></footer>
</body>
</html>`;
}

/**
 * Headers for the callback page. The CSP allows only inline CSS and the
 * data-URI logo: even a page that somehow echoed attacker text could not run
 * script or load anything.
 */
export const PAGE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
