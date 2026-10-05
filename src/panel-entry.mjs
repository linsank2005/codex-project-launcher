import { createPanelServer, currentPanel, DEFAULT_PORT } from './panel.mjs';
import { ensurePanel } from './runtime.mjs';
import { getDataDir } from './store.mjs';
import { openBrowser } from './launcher.mjs';

try {
  if (process.argv.includes('--daemon')) {
    const existing = await currentPanel();
    if (!existing) {
      const panel = await createPanelServer({ port: Number(process.env.START_BUTTONS_PORT || DEFAULT_PORT) });
      const stop = async () => { await panel.close(); process.exit(0); };
      process.once('SIGTERM', stop); process.once('SIGINT', stop);
    }
  } else {
    const info = await ensurePanel(getDataDir());
    console.log(info.url);
    if (process.argv.includes('--open')) await openBrowser(info.url);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
