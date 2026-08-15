# FirstKnock Prospecting Pipeline

This CLI turns licensed Apollo results into a reviewable, independently verified prospect list. It does not send email and deliberately does not scrape Google Maps, LinkedIn, PCT, or NPMA directories.

## Preferred workflow: Apollo MCP

1. In Codex, search Apollo for US pest-control companies with 5–75 employees in the configured markets.
2. Search one relevant decision-maker per company.
3. Review the count and explicitly approve Apollo enrichment credits.
4. Save the enriched connector result as JSON inside the ignored output directory.
5. Run:

```powershell
npm run prospects -- ingest --input C:\path\to\apollo-enriched.json --verifier hunter --max-verifications 100 --confirm-verification-spend 100
```

The MCP path keeps Apollo credentials out of the repository. Apollo search/enrichment must be available on the connected Apollo plan. Copy `env.example` to `.env.prospecting` and add only an independent verifier key.

Keep the target organization ID/domain and the enriched person's current organization ID/domain in the export. A contact cannot become ready unless those employer signals match. Ingest also keeps only the highest-ranked initial decision-maker per company.

Apollo contact data alone does not prove ICP fit. Records without sourced residential-service and D2D/canvassing evidence remain in `prospects.review.csv` and are not sent to the paid verifier.

Before the first real run, initialize the required private suppression file:

```powershell
Copy-Item scripts/prospecting/suppression.example.csv scripts/prospecting/output/suppression.csv
Copy-Item scripts/prospecting/env.example scripts/prospecting/.env.prospecting
```

Real ingest and discovery fail closed if the suppression file is absent or malformed. Known opt-outs are filtered before Hunter or MillionVerifier receives an address.

## Unattended Apollo API workflow

For scheduled use, place an appropriately scoped Apollo API key in `.env.prospecting`. Direct discovery has a hard credit interlock:

```powershell
npm run prospects -- discover --enrich --max-companies 100 --max-credits 104 --confirm-credit-spend 104 --verifier hunter --max-verifications 100 --confirm-verification-spend 100
```

Each pair of spend flags must match exactly. The Apollo cap reserves the maximum search/enrichment exposure and paid Apollo operations are never retried blindly. `run-report.json` records authoritative `credits_consumed` when Apollo returns it and otherwise retains the conservative reservation. The verifier cap limits how many distinct eligible, unsuppressed addresses can be submitted; provider-required transient retries or pending-result polls do not expand that address set. Additional records remain in review.

## Output

Every run writes into the ignored `scripts/prospecting/output/` directory:

- `prospects.ready.csv`: named company-domain email, decision-maker title, current employer confirmed, independently deliverable, residential and canvassing evidence sourced, and not suppressed.
- `prospects.review.csv`: missing verification, catch-all, generic mailbox, title mismatch, or incomplete provenance.
- `prospects.rejected.csv`: suppressed, personal/free, disposable, or undeliverable addresses.
- `prospects.all.csv`: complete audit view.
- `run-report.json`: counts and provider-call metadata without credentials.

Maintain `scripts/prospecting/output/suppression.csv` with `email,domain,reason,opted_out_at`. Imported opt-out markers are also sticky through deduplication. CSV exports escape spreadsheet formulas.

## Dry run

```powershell
npm run prospects -- dry-run
```

Dry runs use fictional `.example` records and make no network calls.

## Source policy

- Apollo/Hunter: official API or installed connector only.
- Individual company sites: not crawled by this version; use their published details only through licensed enrichment evidence.
- FieldRoutes: mark usage as confirmed only when a permitted public source explicitly identifies the company. Apollo/Hunter technology filters do not currently establish FieldRoutes usage.
- PCT, NPMA, LinkedIn, and Google Maps: no automated collection without a separate written license or approved API.

The operator remains responsible for vendor terms, data-source rights, privacy notices, and the global suppression list.
