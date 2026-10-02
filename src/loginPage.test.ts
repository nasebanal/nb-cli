import { describe, it, expect } from "vitest";
import { PAGE_HEADERS, escapeHtml, pickLang, renderLoginPage } from "./loginPage.js";

describe("pickLang", () => {
  it("is Japanese only when the browser's first preference is", () => {
    expect(pickLang("ja,en-US;q=0.9")).toBe("ja");
    expect(pickLang("ja-JP")).toBe("ja");
    expect(pickLang("en-US,ja;q=0.8")).toBe("en");
    expect(pickLang("")).toBe("en");
    expect(pickLang(undefined)).toBe("en");
  });
});

describe("renderLoginPage", () => {
  it("renders the success page with the logo, a status hint, and the page language", () => {
    const en = renderLoginPage({ ok: true, lang: "en" });
    expect(en).toContain('<html lang="en">');
    expect(en).toContain("Logged in");
    expect(en).toContain("You can close this tab and return to your terminal.");
    expect(en).toContain("nb auth status");
    expect(en).toMatch(/<img class="logo" src="data:image\/png;base64,[A-Za-z0-9+/=]{1000,}"/);

    const ja = renderLoginPage({ ok: true, lang: "ja" });
    expect(ja).toContain('<html lang="ja">');
    expect(ja).toContain("ログインしました");
    expect(ja).toContain("ターミナルに戻って");
  });

  it("renders the failure page, pointing back at `nb auth login`", () => {
    const html = renderLoginPage({ ok: false, lang: "en", error: "access_denied" });
    expect(html).toContain("Login failed");
    expect(html).toContain("nb auth login");
    expect(html).toContain("access_denied");
    expect(html).not.toContain("Logged in");
  });

  it("escapes anything that came from the URL and caps its length", () => {
    const html = renderLoginPage({ ok: false, lang: "en", error: `<script>alert("x")</script>&'` });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");

    const long = renderLoginPage({ ok: false, lang: "en", error: "a".repeat(5000) });
    expect(long).not.toContain("a".repeat(201));
  });

  it("is self-contained: no script, no external request", () => {
    const html = renderLoginPage({ ok: true, lang: "en" });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/(?:src|href)="https?:\/\/(?!www\.nasebanal\.com)/);
    expect(html).not.toMatch(/url\(https?:/);
  });
});

describe("PAGE_HEADERS", () => {
  it("locks the page down: no script or network allowed, not cached", () => {
    expect(PAGE_HEADERS["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(PAGE_HEADERS["Content-Security-Policy"]).not.toMatch(/script-src/);
    expect(PAGE_HEADERS["Cache-Control"]).toBe("no-store");
    expect(PAGE_HEADERS["Referrer-Policy"]).toBe("no-referrer");
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});
