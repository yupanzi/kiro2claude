/**
 * Real upstream provider for 💰 manual probes: `.env` at the repo root (optional),
 * kiro-cli SQLite credentials, one `SingleTokenManager` + `KiroProvider`. The two
 * non-obvious bits — tolerating a missing `.env` and silencing the loaders'
 * credential-source diagnostics without muting anything else — live here once.
 */

import { fileURLToPath } from 'node:url';
import { loadCredentialsFromEnv } from '../../src/kiro/credentials-loader.js';
import { KiroProvider } from '../../src/kiro/provider.js';
import { SingleTokenManager } from '../../src/kiro/token-manager.js';
import { loadConfigFromEnv } from '../../src/model/config.js';
import { logger } from '../../src/shared/logger.js';

export interface RealUpstream {
  provider: KiroProvider;
  tokenManager: SingleTokenManager;
}

export function createRealUpstream(): RealUpstream {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../../../.env', import.meta.url)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const level = logger.level;
  try {
    logger.level = 'silent';
    const config = loadConfigFromEnv();
    const loaded = loadCredentialsFromEnv();
    const tokenManager = new SingleTokenManager(config, loaded.credentials, loaded.source);
    return { provider: new KiroProvider(tokenManager), tokenManager };
  } finally {
    logger.level = level;
  }
}
