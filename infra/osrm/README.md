# FirstKnock nationwide OSRM pilot

This is an isolated nationwide U.S. OSRM pilot for **Precision Generate**. The
coverage contract is all 50 states plus the District of Columbia, including
local routing inside Alaska and Hawaii. It does not change the existing
application routing path by itself.

The stack contains:

- a pinned OSRM 26.7.3 MLD server;
- a private Nginx gateway with bearer authentication, bounded timeouts,
  per-client and host-wide rate/concurrency limits, request coalescing, and a
  content-fingerprinted response cache;
- no public port for the raw OSRM process;
- disabled OSRM request logging, `ERROR`-only upstream verbosity, and redacted
  gateway access logs, with request-scoped Nginx error logs discarded, so
  coordinate-bearing URLs are not recorded;
- bounded Docker log files so operational logs cannot consume the graph disk.

The default graph uses OSRM's `foot.lua` profile because FirstKnock currently
describes Precision routes and navigation as walking routes. If reps actually
drive between doors, build and regression-test a separate `car.lua` graph. A
profile change requires rebuilding the graph; it is not merely an API URL
change.

For an approved driving pilot, change both `OSRM_PROFILE_FILE=car.lua` and
`OSRM_API_PROFILE=car` before building. The helper fails closed when those two
labels do not match.

## National build and local gateway

Prerequisites:

- Docker Engine with Compose;
- Bash through WSL, Git Bash, or Linux for the build helper, with GNU
  `md5sum` and `sha256sum` available;
- a dedicated Linux builder with 192–256 GB RAM and at least 1 TB of
  high-throughput build storage for the first measured U.S. `foot.lua` build.
  Local NVMe is preferred; the lower-cost block-volume candidate below must be
  mounted as the build root and benchmarked. These are conservative starting
  estimates, not verified requirements.

Create a local configuration:

```bash
cd infra/osrm
cp osrm.env.example osrm.env
```

Generate a 32-byte hexadecimal gateway secret and place it in `osrm.env`:

```bash
openssl rand -hex 32
```

Set `OSRM_DATA_ROOT` and `OSRM_DATA_DIR` to absolute paths on dedicated storage.
For the priced builder candidate, mount its 1 TB High-Speed Gen2 block volume at
that root; serving replicas should use local NVMe. Do not put a national build
under this repository or another OneDrive-synchronized directory. The helper
refuses an implicit, relative, placeholder, or OneDrive data root and defaults
to preflight guards of 176 GiB Docker-visible RAM and 800 GiB free disk for the
nominal 192+ GB/1 TB builder class.

Build a new immutable U.S. dataset directory:

```bash
chmod +x scripts/build-dataset.sh
./scripts/build-dataset.sh
```

For a production candidate, export `OSRM_REGION_URL` with a timestamped
Geofabrik U.S. PBF before running the helper. Its default `us-latest` URL is
intended only for build testing:

```bash
export OSRM_REGION_URL=https://download.geofabrik.de/north-america/us-YYMMDD.osm.pbf
```

The helper accepts only Geofabrik's official whole-United-States `us-latest`
or six-digit dated URL and the `us-50-states-dc` coverage ID. A state extract
cannot be relabeled and promoted as the nationwide graph.

The helper automatically loads `osrm.env`. It downloads the roughly 11.2 GB
Geofabrik U.S. PBF into a checksum-keyed resumable cache, verifies its published
MD5, records source byte size plus PBF/profile/artifact SHA-256 values, derives
the promoted build fingerprint from the artifact-manifest SHA-256 and pinned
runtime-image digest, and writes per-stage logs while running
`extract -> partition -> customize` and an OSRM trial load. The cached PBF is
mounted read-only instead of copied into each build. The helper refuses to
overwrite an existing build. Copy the three values it prints into `osrm.env`:

```text
OSRM_DATA_DIR=/absolute/path/to/infra/osrm/data/builds/BUILD_ID
OSRM_DATA_VERSION=BUILD_ID
OSRM_BUILD_FINGERPRINT=64_CHARACTER_CONTENT_AND_RUNTIME_SHA256
```

Start the private stack:

```bash
docker compose --env-file osrm.env up -d
```

Startup fails closed if the gateway token or promoted build fingerprint is not
exactly 64 hexadecimal characters. OSRM also verifies the mounted coverage ID,
dataset base, build ID, image digest, profile filename, API profile label,
profile SHA-256, trusted artifact-manifest digest, and every graph artifact
checksum before it begins serving. The gateway grants a 10-minute startup grace
for the national graph; replace that estimate with the measured cold-start
envelope before production.

Run the behavior smoke test from the repository root:

```bash
set -a
source infra/osrm/osrm.env
set +a
node infra/osrm/scripts/smoke-test.mjs
```

The smoke test requires missing/wrong credentials to be rejected, validates the
150 m Precision snap contract, checks a finite local 2x2 matrix in every state
plus DC, verifies matching coverage/data/fingerprint identity, and requires a
repeated request to be a cache hit. The per-jurisdiction probes allow a wider
1 km snap only to prove graph presence; they do not relax the product limit.

The default gateway URL is `http://127.0.0.1:8080`. OSRM itself is reachable
only from the internal Compose network.

A remotely hosted Base44 function cannot reach this loopback address. Keep the
local stack for dataset/regression work; use a TLS-protected staging host that
Base44 can reach when the Precision backend client is introduced.

Stop the stack without deleting its cache volume:

```bash
docker compose --env-file osrm.env stop
```

## Production pilot

The Compose stack deliberately does not terminate public TLS. Put it behind a
TLS load balancer/private network, change `OSRM_GATEWAY_BIND` only when the
firewall is ready, and allow requests only from FirstKnock's backend. Never
expose port 5000. Configure every external load balancer, WAF, and reverse proxy
to omit or redact request paths and query strings because OSRM URLs contain
coordinates.

The earlier small-VPS Texas estimate is not valid nationwide. The lowest
advertised budget candidate found on 2026-08-01 is OVH Game-LE-1: 128 GB ECC
RAM, 2 x 960 GB NVMe, $79/month plus a $79 setup fee. OVH's page also labels the
offer "Coming Soon," so this is an unconfirmed budget candidate, not a
provisionable recommendation. Confirm actual stock and configured price before
using it in the rollout plan. Approve any 128 GB serving node only after the
national walking graph stays at or below 90 GiB RSS under load and the active
plus rollback artifacts retain disk headroom.

A currently listed procurement fallback is phoenixNAP's `s1.c1.medium`: 128 GB
RAM and 2 x 1 TB NVMe at $0.24/hour or $147.87/month per node. phoenixNAP lists
Bare Metal Cloud in Phoenix and Ashburn, but confirm that this exact flavor is
available in both locations before relying on it. Two listed fallback nodes are
about $295.74/month; with one 24-hour monthly builder rental, modest artifact
storage, and optional health checks, the fallback envelope is roughly
$331–335/month before traffic and tax.

For OSRM infrastructure reliability, target one identical replica in Hillsboro
and one in Vint Hill and fail over in the FirstKnock backend, but only if both
can actually be provisioned. The advertised candidate total is $158/month plus
setup. One node plus deterministic continuity fallback protects the user outcome
during a capacity pilot, but it is not OSRM HA.

Build separately. An OVH `r3-256` builder (256 GB RAM, 32 vCPU, 400 GB NVMe)
plus 1 TB High-Speed Gen2 block storage is currently about $1.382/hour. A
24-hour monthly rental is about $33, but the block volume's throughput and actual
build duration must be measured. If both advertised replicas are available, two
replicas, optional DNS health checks, one monthly 24-hour builder rental, and
modest artifact storage are roughly $195/month before tax. Weekly 24-hour
rentals raise that stock-dependent estimate to roughly $295–305/month. These are
budget envelopes, not a claim that the unmeasured national foot graph will fit
or finish within 24 hours on the first-choice hardware.

Do not rebuild data on the only serving host. Build into a new directory on a
standby/builder, run the Precision regression suite, start a candidate instance,
then promote it. Retain the previous build for rollback. Begin with a monthly
full U.S. snapshot during the capacity pilot; move to weekly after the build is
measured or sooner if map-freshness evidence requires it.

## Security and privacy notes

- Use only a 64-character hexadecimal gateway token; arbitrary punctuation can
  break the generated Nginx configuration.
- The gateway cache contains coordinate-bearing request keys. Encrypt/protect
  its disk, restrict operator access, and delete expired volumes according to
  the product retention policy.
- Application logs should contain job IDs, counts, timings, result codes, and
  graph versions—not addresses or coordinates.
- Diagnose gateway failures from the URI-free access log, health state, and
  synthetic requests. Never enable Nginx request-scoped error logs against live
  traffic because Nginx can append the full coordinate URL.
- Include linked `© OpenStreetMap contributors` attribution in the product.
- National coverage means local Precision generation works in every state; it
  does not mean one route group may mix distant markets. Alaska, Hawaii, and
  some pedestrian networks are disconnected components, so cross-component
  matrices return `null` and must use the continuity fallback.
- The U.S. extract does not guarantee routes that leave the country through
  Canada or Mexico. Use a separately benchmarked North America graph if that
  becomes a product requirement.
- This coverage ID means 50 states plus DC. Puerto Rico, the U.S. Virgin
  Islands, Guam, American Samoa, and the Northern Mariana Islands require an
  explicit product decision, appropriate source extracts, separate coverage
  probes, and gateway dispatch before they are advertised.

## What this stack intentionally does not do

- It does not call the public OSRM demo server.
- It does not use OSRM Trip as FirstKnock's optimizer.
- It does not raise the default 100-coordinate Table ceiling.
- It does not silently replace unresolved cells with straight-line estimates.
- It does not change Reorder or the saved-route Optimize button.
- It does not wire non-Precision route creation, Canvas, CSV import, or rep
  workflows into OSRM.

The application integration and release gates are in
[`docs/precision/OSRM_SELF_HOSTING_PLAN.md`](../../docs/precision/OSRM_SELF_HOSTING_PLAN.md).
