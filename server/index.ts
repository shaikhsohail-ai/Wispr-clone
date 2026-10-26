import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { loadConfig, loadDotEnv } from './config.js';
import { createEngines } from './engines/index.js';
import type { LocalEngine } from './engines/local.js';
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

/** How long start-up waits for the local engine's import probe; a hung import must not block the server. */
const LOCAL_PROBE_TIMEOUT_MS = 5_000;

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const version = await readVersion();
  const store = await DictationStore.open(config.dataFile);
  const engines = createEngines(config);
  const polisher = createPolisher({ enabled: config.polishEnabled, model: config.polishModel });
  const app = createApp({ config, store, engines, polisher, version });

  // Let the optional-dependency probe settle (a few ms when the package is missing, ~0.1-0.4 s when it is
  // installed) so the banner and /api/health are accurate from the first request.
  const local = engines.get('local') as LocalEngine | undefined;
  if (local) await Promise.race([local.ready, new Promise<void>((r) => setTimeout(r, LOCAL_PROBE_TIMEOUT_MS).unref())]);

  const server = app.listen(config.port, config.host, () => {
    console.log(`Wispr Clone server listening on http://${config.host}:${config.port}`);
    console.log(`  history file : ${config.dataFile}`);
    console.log(`  web app      : ${config.staticDir ?? 'not built (run "npm run dev" for the Vite dev server, or "npm run build")'}`);
    console.log(`  OpenAI       : ${config.openaiApiKey ? `enabled (${config.openaiModel})` : 'disabled (set OPENAI_API_KEY)'}`);
    console.log(`  Local Whisper: ${local?.available() ? `enabled (${config.localModel})` : 'unavailable'}`);
    console.log(`  AI polish    : ${config.polishEnabled ? `enabled (${config.polishModel})` : 'disabled (set ANTHROPIC_API_KEY)'}`);
    if (config.enableMockEngine) console.log('  Mock engine  : enabled');
    if (config.allowedHosts.length) console.log(`  Allowed hosts: localhost, IP addresses, ${config.allowedHosts.join(', ')}`);
    console.log(`  Password     : ${config.password ? `required (user "${config.username}")` : 'none'}`);
    if (config.password && config.password.length < 8) console.warn('  WARNING: WISPR_PASSWORD is shorter than 8 characters');
    if (!config.password && config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
      console.warn(
        '  WARNING: listening on a non-loopback address without WISPR_PASSWORD; anyone who can reach this port can read and delete the history and use the API keys',
      );
    }
  });

  if (config.localPreload) {
    local?.warmup().catch((err: Error) => console.warn(`[local] preload failed: ${err.message}`));
  }

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, saving history and shutting down`);
    server.close();
    store.flush().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(`[store] dictation history was NOT saved to ${config.dataFile}:`, err);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
