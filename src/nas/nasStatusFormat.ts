import type { NasStatus } from './NasStatusClient';

export function isNasStatusQuery(text: string): boolean {
  const normalized = text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  if (!/\b(nas|serveur|ssd|stockage|disque|plex|vm300)\b/u.test(normalized)) return false;
  return /\b(statut|etat|sante|temperature|temp|ram|memoire|cpu|charge|uptime|disque|stockage|protocole|service|port)\b/u.test(normalized);
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

export function formatNasStatus(status: NasStatus, question?: string): string {
  const root = status.filesystems.find((item) => item.mount === '/') ?? status.filesystems[0];
  const tank = status.filesystems.find((item) => item.mount.includes('tank'));
  const temperatures = status.temperatures.length > 0
    ? status.temperatures.map((item) => `${item.label} ${item.celsius}°C`).join(', ')
    : 'temperature non exposee par la VM';
  const activeProtocols = status.protocols
    .filter((item) => item.available)
    .map((item) => item.name)
    .join(', ') || 'aucun protocole confirme';

  const loadPart = `NAS ${status.hostname} : uptime ${formatUptime(status.uptimeSeconds)}, charge ${status.load.one.toFixed(2)} / ${status.load.five.toFixed(2)}.`;
  const memoryPart = `RAM utilisée ${status.memory.usedPercent}% (${formatBytes(status.memory.totalBytes - status.memory.availableBytes)} sur ${formatBytes(status.memory.totalBytes)}), swap ${status.swap.usedPercent}%.`;
  const diskParts: string[] = [];

  if (root) {
    diskParts.push(`Disque système ${root.usedPercent}% utilisé, ${formatBytes(root.availableBytes)} libres.`);
  }
  if (tank) {
    diskParts.push(`Stockage tank ${tank.usedPercent}% utilisé, ${formatBytes(tank.availableBytes)} libres.`);
  }

  const temperaturePart = `Température : ${temperatures}.`;
  const servicesPart = `Services détectés : ${activeProtocols}.`;
  const normalizedQuestion = (question ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  if (/\btemperature|\btemp\b/u.test(normalizedQuestion)) return temperaturePart;
  if (/\b(ram|memoire|swap)\b/u.test(normalizedQuestion)) return memoryPart;
  if (/\b(disques?|stockage|ssd|espace)\b/u.test(normalizedQuestion)) return diskParts.join(' ');
  if (/\b(service|protocole|port|plex|vm300)\b/u.test(normalizedQuestion)) return servicesPart;
  if (/\b(cpu|charge|uptime)\b/u.test(normalizedQuestion)) return loadPart;

  const parts = [loadPart, memoryPart, ...diskParts];
  parts.push(temperaturePart);
  parts.push(servicesPart);
  return parts.join(' ');
}
