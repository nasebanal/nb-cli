/**
 * ZAP's own JSON report (the `traditional-json` template: `zap-baseline.py -J report.json`) -> the normalised `security` summary,
 * so a ZAP user uploads what ZAP writes, with no converter and no counts typed by hand.
 *
 * What it takes from the report, per alert of each site: the name, the severity (`riskcode` 0 informational, 1 low, 2 medium,
 * 3 high; ZAP has no critical), whether it was marked a false positive (`confidence` 0) and in how many places it was found.
 * It does NOT take what could hold a secret of the scanned system (URLs, parameters, attacks, evidence) or the long texts.
 *
 * - The run FAILS when there is a high alert (what Assurance's security gate fails on); medium and low are findings, not a failure.
 * - A case per alert and site: low and above `failed` (it is a finding), informational `passed`, false positive `skipped`.
 *   False positives are not counted. Most severe first, as only the first failures are kept with a result.
 * - A report that cannot be understood is refused, never read as clean: no `site` list, no site at all (nothing was scanned),
 *   an alert with an unknown severity.
 */
import type { JunitCase, SuiteFailure } from "./junit.js";

export interface ZapSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Alerts by severity, false positives left out. */
  metrics: { high: number; medium: number; low: number; info: number };
  failures: SuiteFailure[];
  cases: JunitCase[];
  status: "passed" | "failed";
  /** The ZAP version that wrote the report, when it says. */
  version: string | null;
}

const LEVELS = ["info", "low", "medium", "high"] as const;
const NOT_ZAP = "is this ZAP's JSON report (the traditional-json template, e.g. zap-baseline.py -J report.json)?";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

interface Alert {
  risk: number;
  falsePositive: boolean;
  case: JunitCase;
}

function readAlert(site: string, raw: unknown): Alert {
  if (!isObject(raw)) throw new Error(`An alert is not an object - ${NOT_ZAP}`);
  const name = text(raw.name) || text(raw.alert) || "(unnamed alert)";
  const code = text(raw.riskcode);
  if (!/^[0-3]$/.test(code)) throw new Error(`The alert "${name}" has no severity this reader knows (riskcode "${code}") - ${NOT_ZAP}`);
  const risk = Number(code);
  const falsePositive = text(raw.confidence) === "0";
  const found = `${text(raw.riskdesc) || "alert"}, ${text(raw.count) || "?"} instance(s)`;
  return {
    risk,
    falsePositive,
    case: {
      name: name.startsWith(site) ? name : `${site} > ${name}`,
      status: falsePositive ? "skipped" : risk >= 1 ? "failed" : "passed",
      duration_ms: null,
      message: falsePositive ? `Marked as a false positive: ${found}` : found,
    },
  };
}

export function summariseZap(report: string): ZapSummary {
  let json: unknown;
  try {
    json = JSON.parse(report);
  } catch {
    throw new Error(`The file is not JSON - ${NOT_ZAP}`);
  }
  if (!isObject(json) || !Array.isArray(json.site)) throw new Error(`No "site" list in the file - ${NOT_ZAP}`);
  if (json.site.length === 0) throw new Error("The report has no site: ZAP scanned nothing (was the target reachable?), so it is not read as clean");

  const alerts = json.site.flatMap((site) => {
    if (!isObject(site) || !Array.isArray(site.alerts)) throw new Error(`A site has no "alerts" list - ${NOT_ZAP}`);
    return site.alerts.map((a) => readAlert(text(site["@name"]) || "site", a));
  });
  alerts.sort((a, b) => b.risk - a.risk);

  const metrics = { high: 0, medium: 0, low: 0, info: 0 };
  for (const a of alerts) if (!a.falsePositive) metrics[LEVELS[a.risk]] += 1;
  // A scan with no alert at all is one passing case: a result with no case reads as nothing having run.
  const cases: JunitCase[] = alerts.length > 0 ? alerts.map((a) => a.case) : [{ name: "zap > no alerts", status: "passed", duration_ms: null, message: null }];
  const count = (status: JunitCase["status"]) => cases.filter((c) => c.status === status).length;

  return {
    total: cases.length,
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
    metrics,
    failures: cases.filter((c) => c.status === "failed").map((c) => ({ name: c.name, message: c.message })),
    cases,
    status: metrics.high > 0 ? "failed" : "passed",
    version: text(json["@version"]).slice(0, 50) || null,
  };
}
