#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { runIngest } from './commands/ingest.js';
import { runToday } from './commands/today.js';
import { runLs } from './commands/ls.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
  version: string;
  description: string;
};

const program = new Command();

program
  .name('tt')
  .description(pkg.description)
  .version(pkg.version, '-v, --version');

program
  .command('ingest')
  .description('Scan ~/.claude/projects for new usage events and write them to the local store')
  .option('-w, --watch', 'Keep running; re-scan every 2s')
  .action(async (opts: { watch?: boolean }) => {
    await runIngest({ watch: opts.watch });
  });

program
  .command('today')
  .description("Today's spend, grouped by repo")
  .action(() => {
    runToday();
  });

program
  .command('ls')
  .description('Recent days with token and cost totals')
  .action(() => {
    runLs();
  });

program.parseAsync();
