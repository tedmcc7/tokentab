#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { runIngest } from './commands/ingest.js';
import { runToday } from './commands/today.js';
import { runLs } from './commands/ls.js';
import { runStart } from './commands/start.js';
import { runStop } from './commands/stop.js';
import { runSwitch } from './commands/switch.js';
import { runReport, type ReportBy } from './commands/report.js';
import { runClassify } from './commands/classify.js';
import { runExport } from './commands/export.js';
import type { CostCategory } from '../core/types.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
  version: string;
  description: string;
};

const program = new Command();

program.name('tt').description(pkg.description).version(pkg.version, '-v, --version');

program
  .command('ingest')
  .description('Scan ~/.claude/projects for new usage events and write them to the local store')
  .option('-w, --watch', 'Keep running; re-scan every 2s')
  .action(async (opts: { watch?: boolean }) => {
    await runIngest({ watch: opts.watch });
  });

program
  .command('start <name>')
  .description("Open a tab for the current repo (errors if one's already open)")
  .option('-n, --note <text>', 'Optional note attached to the tab')
  .option('--cogs', 'Classify the tab as COGS (cost of goods sold)')
  .option('--opex', 'Classify the tab as OpEx (operating expense)')
  .action((name: string, opts: { note?: string; cogs?: boolean; opex?: boolean }) => {
    if (opts.cogs && opts.opex) {
      console.error('--cogs and --opex are mutually exclusive.');
      process.exitCode = 1;
      return;
    }
    const cost_category: CostCategory = opts.cogs ? 'COGS' : opts.opex ? 'OpEx' : 'unclassified';
    runStart(name, { note: opts.note, cost_category });
  });

program
  .command('stop')
  .description('Close the open tab in the current repo and print its cost')
  .action(() => {
    runStop();
  });

program
  .command('switch <name>')
  .description('Stop the open tab (if any) and start a new one — atomic')
  .option('-n, --note <text>', 'Optional note attached to the new tab')
  .option('--cogs', 'Classify the new tab as COGS')
  .option('--opex', 'Classify the new tab as OpEx')
  .action((name: string, opts: { note?: string; cogs?: boolean; opex?: boolean }) => {
    if (opts.cogs && opts.opex) {
      console.error('--cogs and --opex are mutually exclusive.');
      process.exitCode = 1;
      return;
    }
    const cost_category: CostCategory = opts.cogs ? 'COGS' : opts.opex ? 'OpEx' : 'unclassified';
    runSwitch(name, { note: opts.note, cost_category });
  });

program
  .command('classify <tab> <category>')
  .description('Classify a tab (by name or id) as COGS, OpEx, or unclassified')
  .action((tab: string, category: string) => {
    runClassify(tab, category);
  });

program
  .command('today')
  .description("Today's spend, grouped by repo")
  .action(() => {
    runToday();
  });

program
  .command('ls')
  .description('Recent tabs with duration, tokens, and cost')
  .action(() => {
    runLs();
  });

program
  .command('report')
  .description('Spend report grouped by tab, branch, day, PR, or cost category')
  .requiredOption('--by <unit>', 'tab | branch | day | pr | category')
  .action(async (opts: { by: string }) => {
    const valid: ReportBy[] = ['tab', 'branch', 'day', 'pr', 'category'];
    if (!(valid as string[]).includes(opts.by)) {
      console.error(`--by must be one of: ${valid.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    await runReport(opts.by as ReportBy);
  });

program
  .command('export')
  .description('Export priced events as LiteLLM payloads to a URL, a mock receiver, or stdout')
  .option('--to <url>', 'POST one payload per event to this URL')
  .option('--mock', 'Start a localhost receiver, POST events to it, and print the rollup')
  .option('--dry-run', 'Print payloads (one JSON per line) instead of sending')
  .option('--since <date>', 'Only export events at or after this date (YYYY-MM-DD or ISO)')
  .action(async (opts: { to?: string; mock?: boolean; dryRun?: boolean; since?: string }) => {
    await runExport(opts);
  });

program.parseAsync();
