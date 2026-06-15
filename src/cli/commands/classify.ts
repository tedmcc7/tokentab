import { Store } from '../../core/store/index.js';
import type { CostCategory } from '../../core/types.js';

const VALID: readonly CostCategory[] = ['COGS', 'OpEx', 'unclassified'] as const;

/** Case-insensitive normalize: accepts "cogs", "COGS", "Cogs", etc. */
export function parseCategory(s: string): CostCategory | null {
  const lower = s.toLowerCase();
  if (lower === 'cogs') return 'COGS';
  if (lower === 'opex') return 'OpEx';
  if (lower === 'unclassified') return 'unclassified';
  return null;
}

export function runClassify(tabRef: string, categoryArg: string): void {
  const category = parseCategory(categoryArg);
  if (!category) {
    console.error(`Category must be one of: ${VALID.join(', ')}. Got "${categoryArg}".`);
    process.exitCode = 1;
    return;
  }

  const store = new Store();
  const tab = /^\d+$/.test(tabRef) ? store.getTab(Number(tabRef)) : store.findTabByName(tabRef);
  if (!tab) {
    console.error(`No tab found matching "${tabRef}".`);
    process.exitCode = 1;
    store.close();
    return;
  }
  const updated = store.classifyTab(tab.id, category);
  console.log(`Tab "${updated.name}" classified as ${updated.cost_category}.`);
  store.close();
}
