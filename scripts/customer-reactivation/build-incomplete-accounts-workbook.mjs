import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const artifactToolSpecifier = process.env.ARTIFACT_TOOL_ENTRY
  ? pathToFileURL(process.env.ARTIFACT_TOOL_ENTRY).href
  : "@oai/artifact-tool";
const { FileBlob, SpreadsheetFile, Workbook } = await import(
  artifactToolSpecifier
);

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  throw new Error(
    "Usage: node build-incomplete-accounts-workbook.mjs <input.json> <output.xlsx>",
  );
}

const payload = JSON.parse(await fs.readFile(inputPath, "utf8"));
const allRows = Array.isArray(payload.review_rows) ? payload.review_rows : [];
const campaignRows = allRows.filter((row) =>
  row.review_bucket === "campaign_review"
);
const manualRows = allRows.filter((row) =>
  row.review_bucket !== "campaign_review"
);

const palette = {
  ink: "#0B1114",
  green: "#2EEB57",
  greenDark: "#137A34",
  greenSoft: "#E7F9EC",
  yellow: "#F7C948",
  yellowSoft: "#FFF5CC",
  red: "#D64545",
  redSoft: "#FCE8E8",
  blueSoft: "#E8F1FB",
  gray100: "#F4F7F5",
  gray200: "#DDE5E1",
  gray500: "#64706A",
  white: "#FFFFFF",
};

function columnName(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function titleCase(value) {
  return String(value)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function asDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function priorityFor(reason) {
  if (
    ["import_completed_no_route", "import_completed_no_matches"].includes(
      reason,
    )
  ) return "P1";
  if (
    [
      "import_failed",
      "import_stale_pending",
      "import_cancelled",
      "legacy_pull_no_route",
    ].includes(reason)
  ) return "P2";
  return "P3";
}

function compactCohort(value) {
  const text = String(value || "");
  return text.startsWith("A")
    ? "A — Signup stopped"
    : "B — First Precision route stopped";
}

function manualAction(row) {
  if (row.review_bucket === "excluded_active_product_use") {
    return "Do not include in the reactivation campaign; verify the active account context first.";
  }
  if (row.review_bucket === "excluded_rep") {
    return "Do not email as a customer dropout; this is a rep or team-member account.";
  }
  if (String(row.review_bucket || "").startsWith("excluded_")) {
    return "Keep out of outreach.";
  }
  if (String(row.review_bucket || "").startsWith("hold_")) {
    return "Hold and recheck the account state before any outreach.";
  }
  return row.recommended_action;
}

function writeMatrix(sheet, row, col, matrix) {
  if (!matrix.length || !matrix[0]?.length) return;
  sheet.getRangeByIndexes(row, col, matrix.length, matrix[0].length).values =
    matrix;
}

function styleTitle(sheet, range, title, subtitle) {
  sheet.getRange(range).merge();
  sheet.getRange(range).values = [[title]];
  sheet.getRange(range).format = {
    fill: palette.ink,
    font: { bold: true, color: palette.green, size: 20 },
    verticalAlignment: "center",
    horizontalAlignment: "left",
  };
  sheet.getRange(range).format.rowHeight = 34;
  if (subtitle) {
    const start = range.split(":")[0];
    const startRow = Number(start.match(/\d+/)?.[0] || 1);
    const end = range.split(":")[1] || start;
    const endCol = end.match(/[A-Z]+/)?.[0] || "A";
    const subtitleRange = `A${startRow + 2}:${endCol}${startRow + 2}`;
    sheet.getRange(subtitleRange).merge();
    sheet.getRange(subtitleRange).values = [[subtitle]];
    sheet.getRange(subtitleRange).format = {
      font: { color: palette.gray500, italic: true, size: 10 },
      wrapText: true,
    };
  }
}

function styleTableHeader(sheet, range) {
  sheet.getRange(range).format = {
    fill: palette.ink,
    font: { bold: true, color: palette.white },
    verticalAlignment: "center",
    wrapText: true,
  };
  sheet.getRange(range).format.rowHeight = 30;
}

const workbook = Workbook.create();
const dashboard = workbook.worksheets.add("Dashboard");
const campaign = workbook.worksheets.add("Campaign Review");
const manual = workbook.worksheets.add("Manual Review");
const source = workbook.worksheets.add("Source Data");
const notes = workbook.worksheets.add("Rules & Notes");

for (const sheet of [dashboard, campaign, manual, source, notes]) {
  sheet.showGridLines = false;
}

const sourceFields = [
  "primary_user_id",
  "full_name",
  "email",
  "created_at",
  "days_since_signup",
  "account_count",
  "app_role",
  "email_verified",
  "has_seen_onboarding",
  "has_defined_market",
  "has_pulled_data",
  "last_data_pull",
  "area_pulls_count",
  "territory_property_count",
  "subscription_status",
  "stripe_customer_started",
  "paid_account",
  "precision_job_count",
  "latest_precision_job_id",
  "latest_precision_job_status",
  "latest_precision_job_phase",
  "latest_precision_job_updated_at",
  "latest_precision_job_age_minutes",
  "precision_properties_delivered",
  "latest_job_total_fetched",
  "latest_job_total_inserted",
  "latest_job_progress_pct",
  "latest_job_failure_category",
  "usable_route_count",
  "precision_route_count",
  "direct_interaction_count",
  "cohort",
  "reason_code",
  "review_bucket",
  "email_ready",
  "suppression_reason",
  "recommended_email_angle",
  "recommended_action",
];

const sourceMatrix = [
  sourceFields.map(titleCase),
  ...allRows.map((row) =>
    sourceFields.map((field) => {
      if (
        ["created_at", "last_data_pull", "latest_precision_job_updated_at"]
          .includes(field)
      ) {
        return asDate(row[field]);
      }
      const value = row[field];
      return value === undefined ? null : value;
    })
  ),
];
writeMatrix(source, 0, 0, sourceMatrix);
const sourceLastRow = Math.max(2, sourceMatrix.length);
const sourceLastCol = columnName(sourceFields.length - 1);
styleTableHeader(source, `A1:${sourceLastCol}1`);
source.tables.add(
  `A1:${sourceLastCol}${sourceLastRow}`,
  true,
  "IncompleteAccountSourceTable",
).style = "TableStyleMedium2";
source.freezePanes.freezeRows(1);
source.freezePanes.freezeColumns(3);
source.getRange(`D2:D${sourceLastRow}`).format.numberFormat = "yyyy-mm-dd";
source.getRange(`L2:L${sourceLastRow}`).format.numberFormat =
  "yyyy-mm-dd hh:mm";
source.getRange(`V2:V${sourceLastRow}`).format.numberFormat =
  "yyyy-mm-dd hh:mm";
source.getRange(`A1:${sourceLastCol}${sourceLastRow}`).format
  .verticalAlignment = "top";
source.getRange(`B2:C${sourceLastRow}`).format.fill = palette.greenSoft;
source.getRange(`AJ2:AL${sourceLastRow}`).format.wrapText = true;
const sourceWidths = {
  A: 24,
  B: 22,
  C: 32,
  D: 13,
  E: 12,
  F: 10,
  G: 14,
  H: 15,
  I: 12,
  J: 12,
  K: 12,
  L: 18,
  M: 11,
  N: 12,
  O: 16,
  P: 12,
  Q: 10,
  R: 11,
  S: 24,
  T: 15,
  U: 18,
  V: 18,
  W: 12,
  X: 14,
  Y: 12,
  Z: 12,
  AA: 11,
  AB: 18,
  AC: 11,
  AD: 11,
  AE: 12,
  AF: 34,
  AG: 28,
  AH: 24,
  AI: 11,
  AJ: 38,
  AK: 46,
  AL: 48,
};
for (const [col, width] of Object.entries(sourceWidths)) {
  source.getRange(`${col}1:${col}${sourceLastRow}`).format.columnWidth = width;
}

const campaignHeaders = [
  "Priority",
  "Full Name",
  "Email",
  "Cohort",
  "Stage / Reason",
  "Days Since Signup",
  "Created At",
  "Market Drawing Opened",
  "Data Pull Completed",
  "Latest Job Status",
  "Properties Delivered",
  "Stripe Customer Started",
  "Email Ready",
  "Required Next Action",
  "Suggested Email Angle",
  "User ID",
];
const sortedCampaign = [...campaignRows].sort((left, right) => (
  priorityFor(left.reason_code).localeCompare(priorityFor(right.reason_code)) ||
  Number(right.days_since_signup || 0) - Number(left.days_since_signup || 0)
));
const campaignMatrix = [
  campaignHeaders,
  ...sortedCampaign.map((row) => [
    priorityFor(row.reason_code),
    row.full_name,
    row.email,
    compactCohort(row.cohort),
    row.reason_code,
    row.days_since_signup,
    asDate(row.created_at),
    row.has_defined_market ? "Yes" : "No",
    row.has_pulled_data ? "Yes" : "No",
    row.latest_precision_job_status || "No Precision job",
    row.precision_properties_delivered,
    row.stripe_customer_started ? "Yes" : "No",
    "NO — suppression check",
    manualAction(row),
    row.recommended_email_angle,
    row.primary_user_id,
  ]),
];
writeMatrix(campaign, 0, 0, campaignMatrix);
const campaignLastRow = Math.max(2, campaignMatrix.length);
styleTableHeader(campaign, `A1:P1`);
campaign.tables.add(`A1:P${campaignLastRow}`, true, "CampaignReviewTable")
  .style = "TableStyleMedium4";
campaign.freezePanes.freezeRows(1);
campaign.freezePanes.freezeColumns(3);
campaign.getRange(`G2:G${campaignLastRow}`).format.numberFormat = "yyyy-mm-dd";
campaign.getRange(`A2:C${campaignLastRow}`).format.fill = palette.greenSoft;
campaign.getRange(`M2:M${campaignLastRow}`).format.fill = palette.yellowSoft;
campaign.getRange(`N2:O${campaignLastRow}`).format.wrapText = true;
campaign.getRange(`A2:A${campaignLastRow}`).conditionalFormats.add(
  "containsText",
  {
    text: "P1",
    format: { fill: palette.redSoft, font: { bold: true, color: palette.red } },
  },
);
campaign.getRange(`A2:A${campaignLastRow}`).conditionalFormats.add(
  "containsText",
  {
    text: "P2",
    format: { fill: palette.yellowSoft, font: { bold: true } },
  },
);
campaign.getRange(`A2:A${campaignLastRow}`).conditionalFormats.add(
  "containsText",
  {
    text: "P3",
    format: {
      fill: palette.greenSoft,
      font: { bold: true, color: palette.greenDark },
    },
  },
);
const campaignWidths = [
  10,
  22,
  32,
  28,
  28,
  13,
  13,
  15,
  15,
  17,
  14,
  15,
  22,
  48,
  48,
  24,
];
for (let index = 0; index < campaignWidths.length; index += 1) {
  const col = columnName(index);
  campaign.getRange(`${col}1:${col}${campaignLastRow}`).format.columnWidth =
    campaignWidths[index];
}
campaign.getRange(`A1:P${campaignLastRow}`).format.verticalAlignment = "top";

const manualHeaders = [
  "Full Name",
  "Email",
  "Cohort",
  "Stage / Reason",
  "Review Bucket",
  "Product Signals",
  "Why It Is Not in Campaign Review",
  "Recommended Action",
  "User ID",
];
const manualMatrix = [
  manualHeaders,
  ...manualRows.map((row) => [
    row.full_name,
    row.email,
    compactCohort(row.cohort),
    row.reason_code,
    row.review_bucket,
    `Routes: ${row.usable_route_count}; interactions: ${row.direct_interaction_count}; paid: ${
      row.paid_account ? "yes" : "no"
    }`,
    row.suppression_reason,
    row.recommended_action,
    row.primary_user_id,
  ]),
];
writeMatrix(manual, 0, 0, manualMatrix);
const manualLastRow = Math.max(2, manualMatrix.length);
styleTableHeader(manual, "A1:I1");
manual.tables.add(`A1:I${manualLastRow}`, true, "ManualReviewTable").style =
  "TableStyleMedium3";
manual.freezePanes.freezeRows(1);
manual.freezePanes.freezeColumns(2);
manual.getRange(`A2:B${manualLastRow}`).format.fill = palette.blueSoft;
manual.getRange(`F2:H${manualLastRow}`).format.wrapText = true;
const manualWidths = [22, 32, 28, 28, 26, 34, 48, 48, 24];
for (let index = 0; index < manualWidths.length; index += 1) {
  const col = columnName(index);
  manual.getRange(`${col}1:${col}${manualLastRow}`).format.columnWidth =
    manualWidths[index];
}
manual.getRange(`A1:I${manualLastRow}`).format.verticalAlignment = "top";

styleTitle(
  dashboard,
  "A1:H2",
  "FirstKnock Incomplete Precision Onboarding",
  `Production snapshot generated ${
    new Date(payload.generated_at).toLocaleString("en-US", {
      timeZone: "America/Phoenix",
    })
  } America/Phoenix`,
);
dashboard.getRange("A5:H7").merge();
dashboard.getRange("A5:H7").values = [[
  "REVIEW-ONLY LIST — No row is send-ready. Before sending, join deletion requests plus email-provider unsubscribes, complaints, and hard bounces. The current app does not persist those suppressions.",
]];
dashboard.getRange("A5:H7").format = {
  fill: palette.yellowSoft,
  font: { bold: true, color: palette.ink, size: 11 },
  borders: { preset: "outside", style: "medium", color: palette.yellow },
  wrapText: true,
  verticalAlignment: "center",
};

const sourceEnd = allRows.length + 1;
const emailRange = `'Source Data'!$C$2:$C$${sourceEnd}`;
const bucketRange = `'Source Data'!$AH$2:$AH$${sourceEnd}`;
const readyRange = `'Source Data'!$AI$2:$AI$${sourceEnd}`;
const reasonRange = `'Source Data'!$AG$2:$AG$${sourceEnd}`;

const cards = [
  {
    label: "CAMPAIGN REVIEW",
    cell: "A10:B11",
    formula: `=COUNTIF(${bucketRange},"campaign_review")`,
    fill: palette.greenSoft,
  },
  {
    label: "MANUAL / EXCLUDED",
    cell: "D10:E11",
    formula: `=COUNTA(${emailRange})-COUNTIF(${bucketRange},"campaign_review")`,
    fill: palette.yellowSoft,
  },
  {
    label: "TOTAL REVIEW ROWS",
    cell: "G10:H11",
    formula: `=COUNTA(${emailRange})`,
    fill: palette.blueSoft,
  },
  {
    label: "COHORT A — NO ROLE",
    cell: "A14:B15",
    formula:
      `=COUNTIF(${reasonRange},"signup_no_role")+COUNTIF(${reasonRange},"signup_no_role_with_import")`,
    fill: palette.gray100,
  },
  {
    label: "COHORT B — NO ROUTE",
    cell: "D14:E15",
    formula:
      `=COUNTA(${emailRange})-COUNTIF(${reasonRange},"signup_no_role")-COUNTIF(${reasonRange},"signup_no_role_with_import")`,
    fill: palette.gray100,
  },
  {
    label: "SEND-READY NOW",
    cell: "G14:H15",
    formula: `=COUNTIF(${readyRange},TRUE)`,
    fill: palette.redSoft,
  },
];
for (const [index, card] of cards.entries()) {
  const labelRow = index < 3 ? 9 : 13;
  const labelCols = index % 3 === 0 ? "A:B" : index % 3 === 1 ? "D:E" : "G:H";
  const [startCol, endCol] = labelCols.split(":");
  dashboard.getRange(`${startCol}${labelRow}:${endCol}${labelRow}`).merge();
  dashboard.getRange(`${startCol}${labelRow}:${endCol}${labelRow}`).values = [[
    card.label,
  ]];
  dashboard.getRange(`${startCol}${labelRow}:${endCol}${labelRow}`).format = {
    fill: palette.ink,
    font: { bold: true, color: palette.white, size: 9 },
    horizontalAlignment: "center",
  };
  dashboard.getRange(card.cell).merge();
  dashboard.getRange(card.cell.split(":")[0]).formulas = [[card.formula]];
  dashboard.getRange(card.cell).format = {
    fill: card.fill,
    font: { bold: true, color: palette.ink, size: 22 },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    borders: { preset: "outside", style: "thin", color: palette.gray200 },
  };
}

dashboard.getRange("A18:B18").values = [["CAMPAIGN STAGE", "COUNT"]];
styleTableHeader(dashboard, "A18:B18");
const reasonCodes = [
  "drawing_started_no_import",
  "import_completed_no_route",
  "legacy_pull_no_route",
  "manager_no_market",
  "signup_no_role",
  "import_failed",
  "import_cancelled",
  "import_stale_pending",
];
writeMatrix(dashboard, 18, 0, reasonCodes.map((reason) => [reason, null]));
for (let offset = 0; offset < reasonCodes.length; offset += 1) {
  const row = 19 + offset;
  dashboard.getRange(`B${row}`).formulas = [[
    `=COUNTIFS(${reasonRange},A${row},${bucketRange},"campaign_review")`,
  ]];
}
dashboard.tables.add(
  `A18:B${18 + reasonCodes.length}`,
  true,
  "CampaignStageSummaryTable",
).style = "TableStyleMedium4";

dashboard.getRange("D18:E18").values = [["SOURCE ENTITY", "ROWS READ"]];
styleTableHeader(dashboard, "D18:E18");
const sourceCounts = payload.source_counts || {};
const sourceCountRows = [
  ["User", Number(sourceCounts.users || 0)],
  ["FetchJob", Number(sourceCounts.jobs || 0)],
  ["SavedRoute", Number(sourceCounts.routes || 0)],
  ["TeamMember", Number(sourceCounts.team_members || 0)],
  ["InteractionLog", Number(sourceCounts.interactions || 0)],
];
writeMatrix(dashboard, 18, 3, sourceCountRows);
dashboard.tables.add("D18:E23", true, "SourceCountTable").style =
  "TableStyleMedium2";

dashboard.getRange("G18:H18").merge();
dashboard.getRange("G18:H18").values = [["HOW TO USE THIS FILE"]];
styleTableHeader(dashboard, "G18:H18");
dashboard.getRange("G19:H23").merge();
dashboard.getRange("G19:H23").values = [[
  "1. Start with Campaign Review.\n2. Join deletion requests and ESP suppressions.\n3. Keep Manual Review out of the blast.\n4. Use the reason-specific email angle.\n5. Recheck active/recent accounts immediately before send.",
]];
dashboard.getRange("G19:H23").format = {
  fill: palette.gray100,
  font: { color: palette.ink, size: 10 },
  wrapText: true,
  verticalAlignment: "top",
  borders: { preset: "outside", style: "thin", color: palette.gray200 },
};

for (const col of ["A", "B", "D", "E", "G", "H"]) {
  dashboard.getRange(`${col}1:${col}30`).format.columnWidth =
    col === "A" || col === "D" || col === "G" ? 24 : 14;
}
dashboard.getRange("C1:C30").format.columnWidth = 3;
dashboard.getRange("F1:F30").format.columnWidth = 3;
dashboard.freezePanes.freezeRows(3);

styleTitle(
  notes,
  "A1:D2",
  "Cohort Rules, Limitations, and Send Controls",
  "This sheet documents exactly how the production review list was constructed.",
);
notes.getRange("A5:D7").merge();
notes.getRange("A5:D7").values = [[
  "SEND CONTROL: every row is email_ready = FALSE. The app has no durable customer unsubscribe, complaint, hard-bounce, or deletion-request store. The current Delete Account screen logs out but does not persist deletion, so an external suppression join is mandatory.",
]];
notes.getRange("A5:D7").format = {
  fill: palette.redSoft,
  font: { bold: true, color: palette.red, size: 11 },
  borders: { preset: "outside", style: "medium", color: palette.red },
  wrapText: true,
  verticalAlignment: "center",
};

notes.getRange("A9:D9").values = [[
  "RULE",
  "DEFINITION",
  "WHY IT MATTERS",
  "SOURCE",
]];
styleTableHeader(notes, "A9:D9");
const ruleRows = [
  [
    "Cohort A",
    "Email-bearing account, no app role, no live TeamMember match, no usable saved route.",
    "Strongest signal that signup stopped before a customer workspace was selected.",
    "User + TeamMember + SavedRoute",
  ],
  [
    "Cohort B",
    "Manager account with no usable saved route; stage is assigned from the latest Precision FetchJob and onboarding flags.",
    "Separates area-selection, import, and first-route friction.",
    "User + FetchJob + SavedRoute",
  ],
  [
    "Usable route",
    "A SavedRoute associated by platform-stamped created_by or manager_id with at least one property hash.",
    "Matches the app's existing manager-activation definition and avoids emailing active accounts.",
    "getAcquisitionReport + SavedRoute schema",
  ],
  [
    "Precision job join",
    "User.id to precision_usage_user_id; normalized email is the legacy fallback. Canvas jobs are ignored.",
    "Uses the strongest service-stamped ownership key available.",
    "FetchJob schema",
  ],
  [
    "Grace periods",
    "Hold signups younger than 24 hours and pending/running jobs updated within 60 minutes.",
    "Prevents interrupting normal onboarding or an import still in progress.",
    "Export rule",
  ],
  [
    "Activity exclusion",
    "Direct knock/interaction activity excludes the account even when no usable route persisted.",
    "Protects against local-only route saves or incomplete backend persistence.",
    "InteractionLog",
  ],
];
writeMatrix(notes, 9, 0, ruleRows);
notes.tables.add("A9:D15", true, "CohortRulesTable").style =
  "TableStyleMedium4";

notes.getRange("A18:D18").values = [[
  "REASON CODE",
  "MEANING",
  "DEFAULT OUTREACH",
  "SEND STATUS",
]];
styleTableHeader(notes, "A18:D18");
const reasonNotes = [
  [
    "signup_no_role",
    "Account exists but no customer role was selected.",
    "Offer help choosing manager setup.",
    "Suppression check required",
  ],
  [
    "manager_no_market",
    "Manager never opened market drawing and has no Precision job.",
    "Offer a short first-market walkthrough.",
    "Suppression check required",
  ],
  [
    "drawing_started_no_import",
    "Market drawing was opened, but no Precision import was created.",
    "Help finish area selection and start the pull.",
    "Suppression check required",
  ],
  [
    "import_stale_pending",
    "Latest pending/running import has been inactive for more than 60 minutes.",
    "Review the job, then offer troubleshooting.",
    "Manual job check first",
  ],
  [
    "import_failed",
    "Latest Precision import failed.",
    "Use the failure category for support outreach.",
    "Suppression check required",
  ],
  [
    "import_cancelled",
    "Latest Precision import was cancelled.",
    "Offer a low-pressure restart walkthrough.",
    "Suppression check required",
  ],
  [
    "import_completed_no_matches",
    "Import completed but delivered zero qualifying properties.",
    "Help refine the area or filters.",
    "Suppression check required",
  ],
  [
    "import_completed_no_route",
    "Properties were delivered but no usable route persisted.",
    "Highest-priority first-route support.",
    "Suppression check required",
  ],
  [
    "legacy_pull_no_route",
    "User flag shows a previous pull, but no current Precision job or usable route exists.",
    "Review legacy state and help build the route.",
    "Manual state review advised",
  ],
];
writeMatrix(notes, 18, 0, reasonNotes);
notes.tables.add("A18:D27", true, "ReasonCodeTable").style =
  "TableStyleMedium2";

notes.getRange("A30:D32").merge();
notes.getRange("A30:D32").values = [[
  "MEASUREMENT LIMITATION: FirstKnock does not persist route_generation_started/completed/failed events. Route saving is local-first, backend save failures are caught, and very large routes can skip auto-save. Therefore “no SavedRoute” is a strong review signal, not proof that the user never saw a generated route.",
]];
notes.getRange("A30:D32").format = {
  fill: palette.yellowSoft,
  font: { color: palette.ink, italic: true },
  borders: { preset: "outside", style: "thin", color: palette.yellow },
  wrapText: true,
  verticalAlignment: "center",
};
notes.getRange("A1:A35").format.columnWidth = 30;
notes.getRange("B1:B35").format.columnWidth = 56;
notes.getRange("C1:C35").format.columnWidth = 46;
notes.getRange("D1:D35").format.columnWidth = 34;
notes.getRange("A9:D32").format.verticalAlignment = "top";
notes.getRange("A9:D32").format.wrapText = true;
notes.freezePanes.freezeRows(3);

const formulaRangeValues = dashboard.getRange("A9:H27").values;
const formulaErrors = formulaRangeValues.flat().filter((value) => (
  typeof value === "string" &&
  /^#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!)/.test(value)
));
if (formulaErrors.length) {
  throw new Error(`Dashboard formula errors: ${formulaErrors.join(", ")}`);
}
const expectedCardValues = [
  campaignRows.length,
  manualRows.length,
  allRows.length,
  allRows.filter((row) => String(row.cohort || "").startsWith("A")).length,
  allRows.filter((row) => String(row.cohort || "").startsWith("B")).length,
  allRows.filter((row) => row.email_ready === true).length,
];
const actualCardValues = ["A10", "D10", "G10", "A14", "D14", "G14"].map((
  cell,
) => Number(dashboard.getRange(cell).values?.[0]?.[0]));
for (let index = 0; index < expectedCardValues.length; index += 1) {
  if (actualCardValues[index] !== expectedCardValues[index]) {
    throw new Error(
      `Dashboard KPI mismatch at index ${index}: expected ${
        expectedCardValues[index]
      }, received ${actualCardValues[index]}`,
    );
  }
}

const outputDir = path.dirname(outputPath);
await fs.mkdir(outputDir, { recursive: true });

const previewDir = path.join(outputDir, "previews");
await fs.mkdir(previewDir, { recursive: true });
for (
  const sheetName of [
    "Dashboard",
    "Campaign Review",
    "Manual Review",
    "Source Data",
    "Rules & Notes",
  ]
) {
  const preview = await workbook.render({
    sheetName,
    autoCrop: "all",
    scale: 1,
    format: "png",
  });
  const safeName = sheetName.toLowerCase().replaceAll(" ", "-").replaceAll(
    "&",
    "and",
  );
  await fs.writeFile(
    path.join(previewDir, `${safeName}.png`),
    new Uint8Array(await preview.arrayBuffer()),
  );
}

const workbookInspection = await workbook.inspect({
  kind: "workbook,sheet,table,formula",
  maxChars: 8000,
  tableMaxRows: 2,
  tableMaxCols: 4,
  tableMaxCellChars: 40,
});
await fs.writeFile(
  path.join(outputDir, "workbook-inspection.json"),
  JSON.stringify(workbookInspection, null, 2),
  "utf8",
);

const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(outputPath);

const finalBlob = await FileBlob.load(outputPath);
const finalWorkbook = await SpreadsheetFile.importXlsx(finalBlob);
const finalDashboard = finalWorkbook.worksheets.getItem("Dashboard");
const finalDashboardValues = finalDashboard.getRange("A9:H27").values;
const finalFormulaErrors = finalDashboardValues.flat().filter((value) => (
  typeof value === "string" &&
  /^#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!)/.test(value)
));
if (finalFormulaErrors.length) {
  throw new Error(
    `Final workbook formula errors: ${finalFormulaErrors.join(", ")}`,
  );
}
const finalCardValues = ["A10", "D10", "G10", "A14", "D14", "G14"].map((cell) =>
  Number(finalDashboard.getRange(cell).values?.[0]?.[0])
);
for (let index = 0; index < expectedCardValues.length; index += 1) {
  if (finalCardValues[index] !== expectedCardValues[index]) {
    throw new Error(
      `Final workbook KPI mismatch at index ${index}: expected ${
        expectedCardValues[index]
      }, received ${finalCardValues[index]}`,
    );
  }
}
const finalSheetInspection = await finalWorkbook.inspect({
  kind: "sheet,table,formula",
  maxChars: 5000,
  tableMaxRows: 1,
  tableMaxCols: 3,
  tableMaxCellChars: 30,
});
await fs.writeFile(
  path.join(outputDir, "final-workbook-verification.json"),
  JSON.stringify(finalSheetInspection, null, 2),
  "utf8",
);

console.log(JSON.stringify({
  outputPath,
  sheets: [
    "Dashboard",
    "Campaign Review",
    "Manual Review",
    "Source Data",
    "Rules & Notes",
  ],
  totalReviewRows: allRows.length,
  campaignRows: campaignRows.length,
  manualRows: manualRows.length,
  formulaErrors: formulaErrors.length,
  reimportVerified: true,
  previewDir,
}));
