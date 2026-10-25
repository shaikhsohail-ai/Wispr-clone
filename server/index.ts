import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { loadConfig, loadDotEnv } from './config.js';
import { createEngines } from './engines/index.js';
import { createPolisher } from './polish.js';
import { DictationStore } from './store.js';

/** package.json sits one level up from server/ in source, two levels up once compiled into dist-server/. */
async function readVersion(): Promise<string> {
  for (const candidate of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(await readFile(new URL(candidate, import.meta.url), 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      /* try the next location */
    }
  }
  return '0.0.0';
}

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const version = await readVersion();
  const store = await DictationStore.open(config.dataFile);
  const engines = createEngines(config);
  const polisher = createPolisher({ enabled: config.polishEnabled, model: config.polishModel });
  const app = createApp({ config, store, engines, polisher, version });

  const server = app.listen(config.port, config.host, () => {
    console.log(`Wispr Clone server listening on http://${config.host}:${config.port}`);
    console.log(`  history file : ${config.dataFile}`);
    console.log(`  web app      : ${config.staticDir ?? 'not built (run "npm run dev" for the Vite dev server, or "npm run build")'}`);
    console.log(`  OpenAI       : ${config.openaiApiKey ? `enabled (${config.openaiModel})` : 'disabled (set OPENAI_API_KEY)'}`);
    console.log(`  Local Whisper: ${engines.get('local')?.available() ? `enabled (${config.localModel})` : 'unavailable'}`);
    console.log(`  AI polish    : ${config.polishEnabled ? `enabled (${config.polishModel})` : 'disabled (set ANTHROPIC_API_KEY)'}`);
    if (config.enableMockEngine) console.log('  Mock engine  : enabled');
  });

  if (config.localPreload) {
    const local = engines.get('local') as { warmup?: () => Promise<void> } | undefined;
    local?.warmup?.().catch((err: Error) => console.warn(`[local] preload failed: ${err.message}`));
  }

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, saving history and shutting down`);
    server.close();
    store
      .flush()
      .catch((err) => console.error('[store] flush failed:', err))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
