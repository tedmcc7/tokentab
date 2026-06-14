import { bundledPricesPath, Store } from '../../core/store/index.js';
import { ingestOnce } from '../../core/ingest/index.js';

export type IngestCmdOptions = {
  watch?: boolean;
  intervalMs?: number;
};

export async function runIngest(opts: IngestCmdOptions = {}): Promise<void> {
  const store = new Store();
  const seeded = store.seedPricesFromFile(bundledPricesPath());
  if (seeded > 0) console.log(`Seeded ${seeded} price rows from prices.json.`);

  const first = ingestOnce(store);
  console.log(
    `Scanned ${first.files_scanned} file(s); ingested ${first.new_events} new event(s).`,
  );

  if (!opts.watch) {
    store.close();
    return;
  }

  console.log('Watching for new events. Ctrl-C to stop.');
  const interval = opts.intervalMs ?? 2_000;
  const tick = () => {
    const s = ingestOnce(store);
    if (s.new_events > 0) {
      const stamp = new Date().toISOString().slice(11, 19);
      console.log(`[${stamp}] +${s.new_events} event(s)`);
    }
  };
  const id = setInterval(tick, interval);

  await new Promise<void>((resolve) => {
    const stop = () => {
      clearInterval(id);
      store.close();
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
