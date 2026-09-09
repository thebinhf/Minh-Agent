import { buildBriefPack, EMPTY_BRIEF_PACK_PAPER, parseBriefPackArgs, sqlitePaperSource } from "./feed/bb/brief-pack";
import { loadConfig } from "./feed/bb/config";
import { openDb } from "./feed/bb/db";
import { assertNoApiKeys, assertSeparateDb, loadPaperConfig } from "./paper/config";
import { openPaperDb } from "./paper/db";
import { createPaperEngine } from "./paper/engine";
import { httpFeed } from "./paper/feed";
import { paperDesk } from "./paper/ops";
import type { BriefPackPaper } from "./feed/bb/brief-pack";

async function loadLocalPaperDesk(): Promise<BriefPackPaper> {
  try {
    assertNoApiKeys();
    const paperCfg = await loadPaperConfig();
    const feedCfg = await loadConfig();
    assertSeparateDb(paperCfg.dbPath, feedCfg.dbPath);
    if (!(await Bun.file(paperCfg.dbPath).exists())) return { ...EMPTY_BRIEF_PACK_PAPER };
    const store = openPaperDb(paperCfg.dbPath, paperCfg.account);
    try {
      const engine = createPaperEngine({
        store,
        feed: httpFeed(paperCfg.feedUrl),
        config: paperCfg,
        universe: { symbols: feedCfg.symbols, intervals: feedCfg.klineIntervals },
      });
      return paperDesk(engine, sqlitePaperSource(paperCfg.dbPath));
    } finally {
      store.close();
    }
  } catch {
    return { ...EMPTY_BRIEF_PACK_PAPER };
  }
}

async function main(): Promise<void> {
  const { symbol } = parseBriefPackArgs(process.argv.slice(2));
  const config = await loadConfig();
  let store;
  try {
    store = openDb(config.dbPath, true);
  } catch (error) {
    console.error(`Cannot open ${config.dbPath}. Is the tracker running?`);
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  try {
    const paper = await loadLocalPaperDesk();
    console.log(JSON.stringify(buildBriefPack(store, { config, symbol, paper }), null, 2));
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  await main();
}
