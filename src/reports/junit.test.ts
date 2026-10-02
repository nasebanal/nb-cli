import { describe, it, expect } from "vitest";
import { parseJunit } from "./junit.js";

describe("parseJunit", () => {
  it("counts pytest output (single <testsuite>, error and skipped children)", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" errors="1" failures="1" skipped="1" tests="4" time="0.5">
<testcase classname="tests.test_a" name="test_ok" time="0.10"/>
<testcase classname="tests.test_a" name="test_bad" time="0.20"><failure message="assert 1 == 2">trace</failure></testcase>
<testcase classname="tests.test_b" name="test_boom" time="0.15"><error message="KeyError: 'x'">trace</error></testcase>
<testcase classname="tests.test_b" name="test_skip" time="0.05"><skipped type="pytest.skip" message="later"/></testcase>
</testsuite></testsuites>`;
    const r = parseJunit(xml);
    expect(r).toMatchObject({ total: 4, passed: 1, failed: 2, skipped: 1, duration_ms: 500 });
    expect(r.failures).toEqual([
      { name: "tests.test_a > test_bad", message: "assert 1 == 2" },
      { name: "tests.test_b > test_boom", message: "KeyError: 'x'" },
    ]);
  });

  it("counts from <testcase> leaves, not from suite attributes, and handles nested suites", () => {
    const xml = `<testsuites tests="99" failures="99">
<testsuite name="outer" tests="50"><testsuite name="inner" tests="50">
<testcase name="a" classname="x" time="1"/><testcase name="b" classname="x" time="2"><failure/></testcase>
</testsuite></testsuite></testsuites>`;
    expect(parseJunit(xml)).toMatchObject({ total: 2, passed: 1, failed: 1, duration_ms: 3000 });
  });

  it("does not mistake CDATA, comments or escaped text for elements", () => {
    const xml = `<testsuite name="s"><!-- <testcase name="ghost"/> -->
<testcase name="real" classname="c"><system-out><![CDATA[<testcase name="fake"><failure/></testcase>]]></system-out></testcase>
<testcase name="w&amp;x &lt;y&gt;" classname="c"><failure message="a &quot;q&quot; &#65;"/></testcase>
</testsuite>`;
    const r = parseJunit(xml);
    expect(r.total).toBe(2);
    expect(r.failures).toEqual([{ name: "c > w&x <y>", message: 'a "q" A' }]);
  });

  it("reads Playwright-style reports with skipped tests and a status attribute", () => {
    const xml = `<testsuites time="12.5"><testsuite name="login.spec.ts" tests="3">
<testcase name="signs in" classname="login.spec.ts" time="0"/>
<testcase name="skips" classname="login.spec.ts"><skipped/></testcase>
<testcase name="flagged" classname="login.spec.ts" status="skipped"/>
</testsuite></testsuites>`;
    expect(parseJunit(xml)).toMatchObject({ total: 3, passed: 1, failed: 0, skipped: 2, duration_ms: 12500 });
  });

  it("falls back to the failure type, and to an unnamed test", () => {
    const r = parseJunit(`<testsuite><testcase><failure type="AssertionError"/></testcase></testsuite>`);
    expect(r.failures).toEqual([{ name: "(unnamed test)", message: "AssertionError" }]);
    expect(r.duration_ms).toBeNull();
  });

  it("refuses a file with no test cases", () => {
    expect(() => parseJunit("<html><body>not junit</body></html>")).toThrow(/No <testcase>/);
    expect(() => parseJunit("")).toThrow(/No <testcase>/);
  });
});
