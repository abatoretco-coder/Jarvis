import type { NasStatus } from './NasStatusClient';

export function isNasStatusQuery(text: string): boolean {
  const normalized = text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  if (!/\b(nas|serveur|ssd|stockage|disque|plex|vm300)\b/u.test(normalized)) return false;
  return /\b(statut|etat|sante|temperature|temp|ram|memoire|cpu|charge|uptime|disques?|stockage|protocoles?|services?|ports?)\b/u.test(
    normalized
  );
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 Go';
  const gib = value / 1024 / 1024 / 1024;
  return `${Math.round(gib * 10) / 10} Go`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days} j ${hours} h`;
  return `${hours} h`;
}

function qualifyFreshness(status: NasStatus, text: string): string {
  return status.freshness?.state === 'stale' ? `Mesure NAS ancienne. ${text}` : text;
}

export function formatNasStatus(status: NasStatus, question?: string): string {
  const root = status.filesystems.find((item) => item.mount === '/');
  const tank = status.filesystems.find((item) => item.mount.includes('tank'));
  const temperaturePart =
    status.temperatures.length > 0
      ? `Température : ${status.temperatures.map((item) => `${item.label} ${item.celsius}°C`).join(', ')}.`
      : 'Température non mesurée par le NAS.';
  const activeProtocols = status.protocols.filter((item) => item.available);
  const inactiveProtocols = status.protocols.filter((item) => !item.available);
  const servicesPart =
    status.protocols.length === 0
      ? 'Aucun service sondé par le NAS.'
      : activeProtocols.length === 0
        ? `Services sondés mais indisponibles : ${inactiveProtocols.map((item) => item.name).join(', ')}.`
        : `Services disponibles : ${activeProtocols.map((item) => item.name).join(', ')}${
            inactiveProtocols.length > 0
              ? `. Indisponibles : ${inactiveProtocols.map((item) => item.name).join(', ')}`
              : ''
          }.`;

  const loadPart = `NAS ${status.hostname} : uptime ${formatUptime(status.uptimeSeconds)}, charge ${status.load.one.toFixed(2)} / ${status.load.five.toFixed(2)}.`;
  const memoryPart = `RAM utilisée ${status.memory.usedPercent}% (${formatBytes(status.memory.totalBytes - status.memory.availableBytes)} sur ${formatBytes(status.memory.totalBytes)}), swap ${status.swap.usedPercent}%.`;
  const diskParts: string[] = [];

  if (root) {
    diskParts.push(
      `Disque système ${root.usedPercent}% utilisé, ${formatBytes(root.availableBytes)} libres.`
    );
  }
  if (tank && tank !== root) {
    diskParts.push(
      `Stockage tank ${tank.usedPercent}% utilisé, ${formatBytes(tank.availableBytes)} libres.`
    );
  }
  if (diskParts.length === 0 && status.filesystems[0]) {
    const filesystem = status.filesystems[0];
    diskParts.push(
      `Volume ${filesystem.mount} ${filesystem.usedPercent}% utilisé, ${formatBytes(filesystem.availableBytes)} libres.`
    );
  }

  const diskPart =
    diskParts.length > 0 ? diskParts.join(' ') : 'Aucune mesure de disque disponible.';
  const normalizedQuestion = (question ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  if (/\btemperature|\btemp\b/u.test(normalizedQuestion))
    return qualifyFreshness(status, temperaturePart);
  if (/\b(ram|memoire|swap)\b/u.test(normalizedQuestion))
    return qualifyFreshness(status, memoryPart);
  if (/\b(disques?|stockage|ssd|espace)\b/u.test(normalizedQuestion))
    return qualifyFreshness(status, diskPart);
  if (/\b(services?|protocoles?|ports?|plex|vm300)\b/u.test(normalizedQuestion))
    return qualifyFreshness(status, servicesPart);
  if (/\b(cpu|charge|uptime)\b/u.test(normalizedQuestion))
    return qualifyFreshness(status, loadPart);

  const parts = [loadPart, memoryPart, diskPart];
  parts.push(temperaturePart);
  parts.push(servicesPart);
  return qualifyFreshness(status, parts.join(' '));
}
