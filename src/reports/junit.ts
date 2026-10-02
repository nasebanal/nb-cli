/**
 * JUnit XML -> the normalised summary Assurance stores.
 *
 * Covers what vitest (`--reporter=junit`), pytest (`--junitxml`), Specmatic
 * (`--junitReportDir`) and Playwright (`--reporter=junit`) write. Counting is
 * done from the leaf `<testcase>` elements only, never from the `tests=` /
 * `failures=` attributes on `<testsuite>`: those disagree between tools (some
 * count errors as failures, some omit skipped) and double-count nested suites.
 *
 * A small tag scanner instead of an XML dependency: a JUnit file is flat enough,
 * CDATA and comments are skipped whole so a stack trace containing "<testcase"
 * cannot be mistaken for a test, and the CLI keeps a tiny dependency surface.
 */

export interface SuiteFailure {
  name: string;
  message: string | null;
}

export interface JunitSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number | null;
  failures: SuiteFailure[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[m[1]] = decode(m[2] ?? m[3] ?? "");
  }
  return attrs;
}

// comment | CDATA | processing instruction | </close> | <open attrs [/]>
const TAG =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;

interface Case {
  attrs: Record<string, string>;
  state: "passed" | "failed" | "skipped";
  message: string | null;
}

function caseName(attrs: Record<string, string>): string {
  const name = attrs.name ?? "(unnamed test)";
  const cls = attrs.classname;
  return cls && !name.startsWith(cls) ? `${cls} > ${name}` : name;
}

export function parseJunit(xml: string): JunitSummary {
  const cases: Case[] = [];
  let current: Case | null = null;
  let firstSuiteTime: number | null = null;

  for (const m of xml.matchAll(TAG)) {
    const [, closeName, openName, rawAttrs, selfClose] = m;
    if (closeName) {
      if (closeName === "testcase" && current) {
        cases.push(current);
        current = null;
      }
      continue;
    }
    if (!openName) continue; // comment / CDATA / PI

    const attrs = rawAttrs ? parseAttrs(rawAttrs) : {};
    if (openName === "testsuites" || openName === "testsuite") {
      if (firstSuiteTime === null && attrs.time !== undefined && Number.isFinite(Number(attrs.time))) {
        firstSuiteTime = Number(attrs.time);
      }
    } else if (openName === "testcase") {
      current = { attrs, state: attrs.status === "skipped" ? "skipped" : "passed", message: null };
      if (selfClose) {
        cases.push(current);
        current = null;
      }
    } else if (current && (openName === "failure" || openName === "error")) {
      current.state = "failed";
      current.message = current.message ?? (attrs.message || attrs.type || null);
    } else if (current && openName === "skipped" && current.state !== "failed") {
      current.state = "skipped";
    }
  }

  if (cases.length === 0) {
    throw new Error("No <testcase> elements found - is this a JUnit XML file?");
  }

  let seconds = 0;
  for (const c of cases) {
    const t = Number(c.attrs.time);
    if (Number.isFinite(t)) seconds += t;
  }
  if (seconds === 0 && firstSuiteTime !== null) seconds = firstSuiteTime;

  const failed = cases.filter((c) => c.state === "failed");
  const skipped = cases.filter((c) => c.state === "skipped").length;
  return {
    total: cases.length,
    passed: cases.length - failed.length - skipped,
    failed: failed.length,
    skipped,
    duration_ms: seconds > 0 ? Math.round(seconds * 1000) : null,
    failures: failed.map((c) => ({ name: caseName(c.attrs), message: c.message })),
  };
}
