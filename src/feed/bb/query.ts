import { loadConfig } from "./config";
import { openDb } from "./db";
import { parseTimeArg } from "./recovery";

function usage(): never {
  console.log(`Usage:
  bun run query health
  bun run query meta
  bun run query tickers [SYMBOL]
  bun run query orderbooks [SYMBOL]
  bun run query klines SYMBOL [INTERVAL] [--limit N] [--confirm 0|1] [--start TIME] [--end TIME]
  bun run query kline-stats [SYMBOL] [INTERVAL]

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
      console.log(JSON.stringify(store.getHealth(), null, 2));
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
    default:
      usage();
  }
} finally {
  store.close();
}
