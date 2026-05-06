import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

type RefreshTokenStore = Record<string, string>;

const _storeCache = new Map<string, RefreshTokenStore>();

async function loadStore(filePath: string): Promise<RefreshTokenStore> {
  const cached = _storeCache.get(filePath);
  if (cached) return cached;

  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const normalized: RefreshTokenStore = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string' && value.trim()) {
          normalized[key] = value.trim();
        }
      }
      _storeCache.set(filePath, normalized);
      return normalized;
    }
  } catch {
    // Missing/invalid file falls back to an empty store.
  }

  const empty: RefreshTokenStore = {};
  _storeCache.set(filePath, empty);
  return empty;
}

async function saveStore(filePath: string, store: RefreshTokenStore): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
  await rename(tmpPath, filePath);
  _storeCache.set(filePath, store);
}

export async function getStoredRefreshToken(
  filePath: string | undefined,
  tokenKey: string,
): Promise<string | undefined> {
  if (!filePath || !tokenKey.trim()) return undefined;
  const store = await loadStore(filePath);
  const token = store[tokenKey];
  return typeof token === 'string' && token.trim() ? token.trim() : undefined;
}

export async function setStoredRefreshToken(
  filePath: string | undefined,
  tokenKey: string,
  refreshToken: string,
): Promise<void> {
  if (!filePath || !tokenKey.trim() || !refreshToken.trim()) return;
  const store = await loadStore(filePath);
  const next: RefreshTokenStore = { ...store, [tokenKey]: refreshToken.trim() };
  await saveStore(filePath, next);
}
