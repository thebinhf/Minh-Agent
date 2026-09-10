import { loadConfig } from "./config";
import { openDb } from "./db";
import { buildFeedHealth } from "./health";
import { parseTimeArg } from "./recovery";
import { buildChart, buildDepth, buildHeatmap, buildMarket } from "./view";
import { buildOi } from "./oi";

function usage(): never {
  console.log(`Usage:
  bun run query health          # same JSON as GET /health (WS + kline lag)
  bun run query meta
  bun run query tickers [SYMBOL]
  bun run query orderbooks [SYMBOL]
  bun run query klines SYMBOL [INTERVAL] [--limit N] [--confirm 0|1] [--start TIME] [--end TIME]
  bun run query kline-stats [SYMBOL] [INTERVAL]
  bun run query oi [SYMBOL] [INTERVAL] [--limit N]
  bun run query chart [SYMBOL] [INTERVAL] [--limit N] [--start TIME] [--end TIME]
  bun run query depth [SYMBOL]
  bun run query heatmap [SYMBOL] [--limit N] [--bucket STEP] [--start TIME] [--end TIME]
  bun run query market [SYMBOL] [INTERVAL] [--limit N] [--heatmap-limit N] [--bucket STEP]

TIME is Unix epoch milliseconds (13-digit, e.g. 1725600000000), ISO-8601, or YYYY-MM-DD.
Seconds (10-digit) are not accepted. For a dump file / URL use: bun run backfill --from PATH|URL
`);
  process.exit(2);
}

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

const config = await loadConfig();
const command = process.argv[2];
if (!command) usage();

let store;
try {
  store = openDb(config.dbPath, true);
} catch (error) {
  console.error(`Cannot open ${config.dbPath}. Is the tracker running?`);
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

try {
  switch (command) {
    case "health":
      console.log(JSON.stringify(buildFeedHealth(store, config), null, 2));
      break;
    case "meta":
      console.log(JSON.stringify(store.getMeta(), null, 2));
      break;
    case "tickers":
      console.log(JSON.stringify(store.listTickers(process.argv[3]), null, 2));
      break;
    case "orderbooks":
      console.log(JSON.stringify(store.listOrderbooks(process.argv[3]), null, 2));
      break;
    case "klines": {
      const symbol = process.argv[3];
      if (!symbol) usage();
      const rest = process.argv.slice(4);
      const interval = rest.find((arg) => !arg.startsWith("--"));
      const limitRaw = flag(rest, "--limit");
      const confirmRaw = flag(rest, "--confirm");
      const startRaw = flag(rest, "--start");
      const endRaw = flag(rest, "--end");
      console.log(
        JSON.stringify(
          store.listKlines({
            symbol,
            interval,
            limit: limitRaw ? Number(limitRaw) : 20,
            confirm: confirmRaw === undefined ? undefined : confirmRaw === "1" || confirmRaw === "true",
            startTs: startRaw ? parseTimeArg(startRaw) : undefined,
            endTs: endRaw ? parseTimeArg(endRaw) : undefined,
            maxLimit: 20_000,
          }),
          null,
          2,
        ),
      );
      break;
    }
    case "kline-stats":
      console.log(JSON.stringify(store.klineStats(process.argv[3], process.argv[4]), null, 2));
      break;
    case "oi": {
      const rest = process.argv.slice(3);
      const positional = rest.filter((arg) => !arg.startsWith("--"));
      const limitRaw = flag(rest, "--limit");
      const body = buildOi(store, {
        symbol: positional[0],
        interval: positional[1],
        dbPath: config.dbPath,
        limit: limitRaw ? Number(limitRaw) : undefined,
      });
      if ("error" in body) {
        console.error(JSON.stringify(body, null, 2));
        process.exit(2);
      }
      console.log(JSON.stringify(body, null, 2));
      break;
    }
    case "chart": {
      const rest = process.argv.slice(3);
      const positional = rest.filter((arg) => !arg.startsWith("--"));
      const startRaw = flag(rest, "--start");
      const endRaw = flag(rest, "--end");
      const limitRaw = flag(rest, "--limit");
      console.log(JSON.stringify(buildChart(store, {
        symbol: positional[0],
        interval: positional[1],
        limit: limitRaw ? Number(limitRaw) : undefined,
        startTs: startRaw ? parseTimeArg(startRaw) : undefined,
        endTs: endRaw ? parseTimeArg(endRaw) : undefined,
      }), null, 2));
      break;
    }
    case "depth":
      console.log(JSON.stringify(buildDepth(store, { symbol: process.argv[3] }), null, 2));
      break;
    case "market": {
      const rest = process.argv.slice(3);
      const positional = rest.filter((arg) => !arg.startsWith("--"));
      const limitRaw = flag(rest, "--limit");
      const heatLimitRaw = flag(rest, "--heatmap-limit");
      const bucketRaw = flag(rest, "--bucket");
      const bucket = bucketRaw ? Number(bucketRaw) : Number.NaN;
      console.log(JSON.stringify(buildMarket(store, {
        symbol: positional[0],
        interval: positional[1],
        limit: limitRaw ? Number(limitRaw) : undefined,
        heatmapLimit: heatLimitRaw ? Number(heatLimitRaw) : undefined,
        bucket: Number.isFinite(bucket) && bucket > 0 ? bucket : null,
      }), null, 2));
      break;
    }
    case "heatmap": {
      const rest = process.argv.slice(3);
      const positional = rest.filter((arg) => !arg.startsWith("--"));
      const startRaw = flag(rest, "--start");
      const endRaw = flag(rest, "--end");
      const limitRaw = flag(rest, "--limit");
      const bucketRaw = flag(rest, "--bucket");
      const bucket = bucketRaw ? Number(bucketRaw) : Number.NaN;
      console.log(JSON.stringify(buildHeatmap(store, {
        symbol: positional[0],
        limit: limitRaw ? Number(limitRaw) : undefined,
        startTs: startRaw ? parseTimeArg(startRaw) : undefined,
        endTs: endRaw ? parseTimeArg(endRaw) : undefined,
        bucket: Number.isFinite(bucket) && bucket > 0 ? bucket : null,
      }), null, 2));
      break;
    }
    default:
      usage();
  }
} finally {
  store.close();
}
