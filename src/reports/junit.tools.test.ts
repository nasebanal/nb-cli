import { describe, expect, it } from "vitest";
import { parseJunit } from "./junit.js";

// One sample per tool and format generation, written the way each tool writes it. The parser counts <testcase> leaves
// only, so a tool or version that moves attributes around, wraps its suites differently or adds elements (properties,
// system-out) must still give the same counts. When a new tool version changes the layout, add its sample here.

const EXPECT = { total: 3, passed: 1, failed: 1, skipped: 1 };

describe("JUnit samples by tool", () => {
  it("pytest, xunit2 (the default since 6.0): <testsuites> wrapper, properties, file / line on each case", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="0" failures="1" skipped="1" tests="3" time="0.121" timestamp="2026-10-15T06:12:00" hostname="ci">
<properties><property name="x" value="1"/></properties>
<testcase classname="tests.test_accounts" name="test_ok" file="tests/test_accounts.py" line="3" time="0.010"/>
<testcase classname="tests.test_accounts" name="test_bad" file="tests/test_accounts.py" line="9" time="0.020"><failure message="assert 1 == 2">def test_bad():
&gt;       assert 1 == 2
E       assert 1 == 2</failure><system-out>log line</system-out></testcase>
<testcase classname="tests.test_accounts" name="test_later" time="0.000"><skipped type="pytest.skip" message="not yet">tests/test_accounts.py:14: not yet</skipped></testcase>
</testsuite></testsuites>`;
    const r = parseJunit(xml);
    expect(r).toMatchObject(EXPECT);
    expect(r.cases.map((c) => c.name)).toEqual(["tests.test_accounts > test_ok", "tests.test_accounts > test_bad", "tests.test_accounts > test_later"]);
  });

  it("pytest, xunit1 / legacy: a bare <testsuite> with no wrapper and no file / line", () => {
    const xml = `<testsuite errors="0" failures="1" name="pytest" skipped="1" tests="3" time="0.2"><testcase classname="t" name="a" time="0.1"/><testcase classname="t" name="b" time="0.1"><failure message="boom"/></testcase><testcase classname="t" name="c" time="0"><skipped message="x"/></testcase></testsuite>`;
    expect(parseJunit(xml)).toMatchObject(EXPECT);
  });

  it("pytest, a test that errors (setup / fixture): an <error> counts as a failure, not as a pass", () => {
    const xml = `<testsuite name="pytest" errors="1" tests="2"><testcase classname="t" name="ok"/><testcase classname="t" name="needs_db"><error message="fixture 'db' error">trace</error></testcase></testsuite>`;
    expect(parseJunit(xml)).toMatchObject({ total: 2, passed: 1, failed: 1, skipped: 0 });
  });

  it("vitest (--reporter=junit): one <testsuite> per file under <testsuites>, the file as classname", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="3" failures="1" errors="0" time="0.45">
    <testsuite name="src/lib/money.test.ts" timestamp="2026-10-15T06:12:00.000Z" hostname="ci" tests="3" failures="1" errors="0" skipped="1" time="0.011">
        <testcase classname="src/lib/money.test.ts" name="adds" time="0.002"></testcase>
        <testcase classname="src/lib/money.test.ts" name="rounds" time="0.004">
            <failure message="expected 1 to be 2" type="AssertionError">AssertionError: expected 1 to be 2
 ❯ src/lib/money.test.ts:9:3</failure>
        </testcase>
        <testcase classname="src/lib/money.test.ts" name="todo" time="0">
            <skipped/>
        </testcase>
    </testsuite>
</testsuites>`;
    expect(parseJunit(xml)).toMatchObject(EXPECT);
  });

  it("Playwright (--reporter=junit): <testsuites> with id / name, a suite per file, CDATA in system-out and failures, a retried test", () => {
    const xml = `<testsuites id="" name="" tests="3" failures="1" skipped="1" errors="0" time="5.2">
<testsuite name="login.spec.ts" timestamp="2026-10-15T06:12:00.000Z" hostname="chromium" tests="3" failures="1" skipped="1" time="5.1" errors="0">
<testcase name="login › shows the form" classname="login.spec.ts" time="1.2"><system-out><![CDATA[<testcase name="not a case"/>]]></system-out></testcase>
<testcase name="login › rejects a bad password" classname="login.spec.ts" time="2.8"><failure message="login.spec.ts:20:5 rejects a bad password" type="FAILURE"><![CDATA[Error: expect(received).toBeVisible()
<testcase name="also not a case"/>]]></failure></testcase>
<testcase name="login › remembers me" classname="login.spec.ts" time="0"><skipped/></testcase>
</testsuite></testsuites>`;
    const r = parseJunit(xml);
    expect(r).toMatchObject(EXPECT);
    expect(r.duration_ms).toBe(4000); // the sum of the cases' times, whatever the suite attributes say
  });

  it("Specmatic (JUnit Jupiter): one <testsuite> named after the engine, a case per generated request, skipped ones carry a message", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="JUnit Jupiter" tests="3" skipped="1" failures="1" errors="0" time="1.9" hostname="ci">
  <testcase name="[1] POST /accounts -> 201 | EX:CREATED" classname="ContractTests" time="0.4"/>
  <testcase name="[2] GET /accounts/{id} -> 200" classname="ContractTests" time="0.3"><failure message="Expected status 200 but got 500" type="org.opentest4j.AssertionFailedError"/></testcase>
  <testcase name="[3] DELETE /accounts/{id} -> 204" classname="ContractTests" time="0"><skipped message="excluded"/></testcase>
</testsuite>`;
    expect(parseJunit(xml)).toMatchObject(EXPECT);
  });

  it("a ZAP report converted by nb-quickstarts (bin/zap_to_junit.mjs): a failed case per alert of Low or above", () => {
    const xml = `<testsuites><testsuite name="zap" tests="3" failures="1">
<testcase classname="http://frontend:5173" name="Content Security Policy (CSP) Header Not Set"><failure message="Medium (High), 4 instance(s)"/></testcase>
<testcase classname="http://frontend:5173" name="Modern Web Application"/>
<testcase classname="http://frontend:5173" name="Non-Storable Content"><skipped/></testcase>
</testsuite></testsuites>`;
    expect(parseJunit(xml)).toMatchObject(EXPECT);
  });
});
