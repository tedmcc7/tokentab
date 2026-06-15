import { Store } from '../../core/store/index.js';
import { normalizeRepo } from '../../core/ingest/index.js';
import type { CostCategory } from '../../core/types.js';

export function runStart(
  name: string,
  opts: { note?: string; cost_category?: CostCategory },
): void {
  const store = new Store();
  const repo = normalizeRepo(process.cwd());
  try {
    const tab = store.startTab(name, repo, {
      note: opts.note ?? null,
      cost_category: opts.cost_category ?? 'unclassified',
    });
    const where = repo === null ? '(no repo detected)' : `repo "${repo}"`;
    console.log(`Started tab "${tab.name}" in ${where} (${tab.cost_category}).`);
    if (tab.note) console.log(`  note: ${tab.note}`);
    console.log(`  started_at: ${tab.started_at}`);
  } catch (err) {
    console.error((err as Error).message);
    console.error('Run `tt stop` to close it, or `tt switch <name>` to atomically swap.');
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
