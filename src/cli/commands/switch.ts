import { Store } from '../../core/store/index.js';
import { normalizeRepo } from '../../core/ingest/index.js';
import type { CostCategory } from '../../core/types.js';
import { formatDuration } from '../format.js';

export function runSwitch(
  name: string,
  opts: { note?: string; cost_category?: CostCategory },
): void {
  const store = new Store();
  const repo = normalizeRepo(process.cwd());
  const { stopped, started } = store.switchTab(name, repo, {
    note: opts.note ?? null,
    cost_category: opts.cost_category ?? 'unclassified',
  });
  if (stopped) {
    console.log(
      `Stopped "${stopped.name}" (${formatDuration(stopped.started_at, stopped.ended_at!)}).`,
    );
  }
  console.log(`Started "${started.name}" (${started.cost_category}).`);
  store.close();
}
