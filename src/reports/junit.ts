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

/** One test, as kept per-case in Assurance (outcome, time, and the failure text when there is one). */
export interface JunitCase {
  name: string;
  status: "passed" | "failed" | "skipped";
  duration_ms: number | null;
  message: string | null;
}

export interface JunitSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number | null;
  failures: SuiteFailure[];
  /** Every test case in file order; the caller decides how many to send. */
  cases: JunitCase[];
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
  /** Text inside <failure>/<error> (usually the stack trace), first one wins. */
  trace: string | null;
}

/** Element text with CDATA unwrapped, or entity-decoded when it is plain text. */
function elementText(raw: string): string | null {
  const cdata = [...raw.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((m) => m[1]);
  const text = (cdata.length > 0 ? cdata.join("") : decode(raw)).trim();
  return text === "" ? null : text;
}

function caseName(attrs: Record<string, string>): string {
  const name = attrs.name ?? "(unnamed test)";
  const cls = attrs.classname;
  return cls && !name.startsWith(cls) ? `${cls} > ${name}` : name;
}

export function parseJunit(xml: string): JunitSummary {
  const cases: Case[] = [];
  let current: Case | null = null;
  let textFrom = -1; // where the text of the open <failure>/<error> starts
  let firstSuiteTime: number | null = null;

  for (const m of xml.matchAll(TAG)) {
    const [, closeName, openName, rawAttrs, selfClose] = m;
    if (closeName) {
      if ((closeName === "failure" || closeName === "error") && current && textFrom >= 0) {
        current.trace = current.trace ?? elementText(xml.slice(textFrom, m.index));
        textFrom = -1;
      }
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
      current = { attrs, state: attrs.status === "skipped" ? "skipped" : "passed", message: null, trace: null };
      if (selfClose) {
        cases.push(current);
        current = null;
      }
    } else if (current && (openName === "failure" || openName === "error")) {
      current.state = "failed";
      current.message = current.message ?? (attrs.message || attrs.type || null);
      if (!selfClose) textFrom = (m.index ?? 0) + m[0].length;
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
    cases: cases.map((c) => {
      const t = Number(c.attrs.time);
      // The failure text is the attribute plus the trace when the trace adds something.
      const message = [c.message, c.trace && c.trace !== c.message ? c.trace : null].filter(Boolean).join("\n");
      return {
        name: caseName(c.attrs),
        status: c.state,
        duration_ms: c.attrs.time !== undefined && Number.isFinite(t) ? Math.round(t * 1000) : null,
        message: message === "" ? null : message,
      };
    }),
  };
}
