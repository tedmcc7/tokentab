import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('package.json', () => {
  it('has name tokentab and a tt bin entry', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
      name: string;
      bin: Record<string, string>;
      version: string;
    };
    expect(pkg.name).toBe('tokentab');
    expect(pkg.bin.tt).toBeDefined();
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('prices.json', () => {
  it('has valid price rows with all required fields and positive rates', () => {
    const { prices } = JSON.parse(readFileSync(join(root, 'prices.json'), 'utf-8')) as {
      prices: Array<{
        model: string;
        effective_date: string;
        input_per_mtok: number;
        output_per_mtok: number;
        cache_write_per_mtok: number;
        cache_read_per_mtok: number;
      }>;
    };

    expect(prices.length).toBeGreaterThan(0);

    for (const row of prices) {
      expect(typeof row.model, `model field for row: ${JSON.stringify(row)}`).toBe('string');
      expect(row.effective_date, `effective_date for ${row.model}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.input_per_mtok, `input_per_mtok for ${row.model}`).toBeGreaterThan(0);
      expect(row.output_per_mtok, `output_per_mtok for ${row.model}`).toBeGreaterThan(0);
      expect(row.cache_write_per_mtok, `cache_write_per_mtok for ${row.model}`).toBeGreaterThan(0);
      expect(row.cache_read_per_mtok, `cache_read_per_mtok for ${row.model}`).toBeGreaterThan(0);
    }
  });
});
