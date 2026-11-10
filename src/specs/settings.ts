/**
 * `nb specs specs settings <id>` - a spec's public settings (since 2026-11-10 these are columns of the spec, not of its
 * repository): the quality badge, who may read the report, and the button that issues new public links. One `PATCH /specs/{id}`
 * with only the fields asked for. The Evolution screen's Spec detail has the same fields (public badge and report with their
 * links). Whether a result may carry the original report (`attachments_enabled`) is the REPOSITORY's: `nb specs repositories
 * upsert|update --attachments`. There is no API version rule any more: a spec has ONE API version (v1, v2), so a result needs none.
 */
import { ApiError, request } from "../http.js";
import { headersOf, reasonOf, type Envelope, type SpecsConnection } from "./push.js";

export const REPORT_ACCESS = ["hidden", "login", "public"] as const;

export interface SpecSettingsPatch {
  public_badge?: boolean;
  report_access?: (typeof REPORT_ACCESS)[number];
  rotate_quality_public_id?: true;
}

/** `on|off` (also true/false, yes/no, 1/0) as a boolean; anything else is a mistake worth saying so. */
export function onOff(flag: string, raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (["on", "true", "yes", "1"].includes(v)) return true;
  if (["off", "false", "no", "0"].includes(v)) return false;
  throw new Error(`${flag} '${raw}' must be on or off`);
}

/** The flags of `settings` as the PATCH body; at least one is required (a PATCH that changes nothing is a mistake). */
export function parseSettingsFlags(o: { publicBadge?: string; reportAccess?: string; rotateQualityPublicId?: boolean }): SpecSettingsPatch {
  const patch: SpecSettingsPatch = {};
  if (o.publicBadge !== undefined) patch.public_badge = onOff("--public-badge", o.publicBadge);
  if (o.reportAccess !== undefined) {
    const v = o.reportAccess.trim().toLowerCase();
    if (!(REPORT_ACCESS as readonly string[]).includes(v)) throw new Error(`--report-access '${o.reportAccess}' must be one of: ${REPORT_ACCESS.join(", ")}`);
    patch.report_access = v as (typeof REPORT_ACCESS)[number];
  }
  if (o.rotateQualityPublicId) patch.rotate_quality_public_id = true;
  if (Object.keys(patch).length === 0) {
    throw new Error("Nothing to change: pass at least one of --public-badge, --report-access, --rotate-quality-public-id");
  }
  return patch;
}

export interface SpecWithSettings {
  id: string;
  name: string;
  public_badge: boolean;
  report_access: string;
  quality_public_id: string | null;
}

export async function updateSpecSettings(conn: SpecsConnection, id: string, patch: SpecSettingsPatch): Promise<SpecWithSettings> {
  try {
    const res = await request({ ...headersOf(conn), method: "PATCH", path: `/api/v1/specs/${encodeURIComponent(id)}`, body: patch });
    return (res.data as Envelope<SpecWithSettings>).data;
  } catch (err) {
    if (err instanceof ApiError) throw new Error(`The catalog refused the settings: ${reasonOf(err)}`);
    throw err;
  }
}
