/* global console, process */

import fs from 'node:fs';
import path from 'node:path';

const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/generate-home-plan-assets.mjs <home.json>');

const sourcePath = path.resolve(input);
const home = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const outputDir = path.dirname(sourcePath);
const level = home.geometry.levels[0];
const rooms = home.rooms.filter((room) => room.levelId === level.levelId);
const colors = ['#A7C7E7', '#C6E5B1', '#F6D6A8', '#E8B4BC', '#D5C5E9', '#B8E0D2'];
const scale = 72;
const padding = 72;
const titleHeight = 92;
const maxX = Math.max(...level.footprint.map(([x]) => x));
const maxY = Math.max(...level.footprint.map(([, y]) => y));
const width = Math.ceil(maxX * scale + padding * 2);
const height = Math.ceil(maxY * scale + padding * 2 + titleHeight);
const sx = (x) => padding + x * scale;
const sy = (y) => titleHeight + padding + y * scale;
const points = (polygon) => polygon.map(([x, y]) => `${sx(x).toFixed(2)},${sy(y).toFixed(2)}`).join(' ');
const centroid = (polygon) => {
  let area2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    const cross = x1 * y2 - x2 * y1;
    area2 += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  return [cx / (3 * area2), cy / (3 * area2)];
};

const roomSvg = rooms.map((room, index) => {
  const [cx, cy] = centroid(room.polygon);
  return `<g><polygon points="${points(room.polygon)}" fill="${colors[index % colors.length]}" stroke="#172033" stroke-width="3"/><text x="${sx(cx).toFixed(2)}" y="${sy(cy).toFixed(2)}" text-anchor="middle" class="room"><tspan x="${sx(cx).toFixed(2)}" dy="-0.2em">${room.name}</tspan><tspan x="${sx(cx).toFixed(2)}" dy="1.25em" class="area">${room.certifiedAreaM2.toFixed(2)} m²</tspan></text></g>`;
}).join('\n');

const openingSvg = home.openings.map((opening) => {
  const [[x1, y1], [x2, y2]] = opening.segment;
  const isWindow = opening.kind === 'window';
  return `<line x1="${sx(x1).toFixed(2)}" y1="${sy(y1).toFixed(2)}" x2="${sx(x2).toFixed(2)}" y2="${sy(y2).toFixed(2)}" stroke="${isWindow ? '#1C9BD1' : '#F28C28'}" stroke-width="${isWindow ? 8 : 7}" stroke-linecap="round"><title>${opening.openingId} — position estimée</title></line>`;
}).join('\n');

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    text { font-family: Inter, Segoe UI, Arial, sans-serif; fill: #172033; }
    .title { font-size: 26px; font-weight: 700; }
    .subtitle { font-size: 15px; fill: #596273; }
    .room { font-size: 16px; font-weight: 700; pointer-events: none; }
    .area { font-size: 13px; font-weight: 500; }
    .legend { font-size: 13px; }
  </style>
  <rect width="100%" height="100%" fill="#F8FAFC"/>
  <text x="${padding}" y="42" class="title">${home.displayName} — plan 2D de travail</text>
  <text x="${padding}" y="68" class="subtitle">Surfaces certifiées · géométrie estimée · façade sud en haut</text>
  ${roomSvg}
  ${openingSvg}
  <g transform="translate(${padding},${height - 24})" class="legend">
    <line x1="0" y1="-5" x2="32" y2="-5" stroke="#1C9BD1" stroke-width="7" stroke-linecap="round"/><text x="42" y="0">fenêtre estimée</text>
    <line x1="190" y1="-5" x2="222" y2="-5" stroke="#F28C28" stroke-width="7" stroke-linecap="round"/><text x="232" y="0">porte estimée</text>
    <text x="410" y="0">Échelle graphique : 1 m = ${scale} px</text>
  </g>
</svg>
`;
fs.writeFileSync(path.join(outputDir, 'plan-2d.svg'), svg);

const mtl = rooms.map((room, index) => {
  const hex = colors[index % colors.length].slice(1);
  const rgb = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  return `newmtl ${room.roomId}\nKd ${rgb.map((v) => v.toFixed(4)).join(' ')}\nKa 0.1500 0.1500 0.1500\nKs 0.0500 0.0500 0.0500\n`;
}).join('\n') + '\nnewmtl walls\nKd 0.9300 0.9300 0.9000\nKa 0.2000 0.2000 0.2000\nKs 0.0500 0.0500 0.0500\n';
const openingMaterials = '\nnewmtl windows\nKd 0.1098 0.6078 0.8196\nKa 0.0500 0.1500 0.2000\nKs 0.2000 0.2000 0.2000\n\nnewmtl doors\nKd 0.9490 0.5490 0.1569\nKa 0.2000 0.1000 0.0300\nKs 0.1000 0.1000 0.1000\n';
fs.writeFileSync(path.join(outputDir, 'plan-3d.mtl'), mtl + openingMaterials);

const obj = ['# Jarvis apartment model — estimated geometry', 'mtllib plan-3d.mtl'];
let vertexOffset = 1;
const addPrism = (name, polygon, z0, z1, material) => {
  obj.push(`o ${name}`, `usemtl ${material}`);
  for (const [x, y] of polygon) obj.push(`v ${x.toFixed(6)} ${y.toFixed(6)} ${z0.toFixed(6)}`);
  for (const [x, y] of polygon) obj.push(`v ${x.toFixed(6)} ${y.toFixed(6)} ${z1.toFixed(6)}`);
  const n = polygon.length;
  obj.push(`f ${Array.from({ length: n }, (_, i) => vertexOffset + i).join(' ')}`);
  obj.push(`f ${Array.from({ length: n }, (_, i) => vertexOffset + n + (n - 1 - i)).join(' ')}`);
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    obj.push(`f ${vertexOffset + i} ${vertexOffset + j} ${vertexOffset + n + j} ${vertexOffset + n + i}`);
  }
  vertexOffset += n * 2;
};

for (const room of rooms) addPrism(`floor_${room.roomId}`, room.polygon, 0, 0.04, room.roomId);

const wallThickness = 0.08;
const wallHeight = level.ceilingHeightM;
const edgeKey = (a, b) => [a, b].sort((p, q) => p[0] - q[0] || p[1] - q[1]).map((p) => p.join(',')).join('|');
const edges = new Map();
for (const room of rooms) {
  for (let i = 0; i < room.polygon.length; i += 1) {
    const a = room.polygon[i];
    const b = room.polygon[(i + 1) % room.polygon.length];
    edges.set(edgeKey(a, b), [a, b]);
  }
}
let wallIndex = 0;
for (const [a, b] of edges.values()) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length < 0.01) continue;
  const nx = (-dy / length) * wallThickness / 2;
  const ny = (dx / length) * wallThickness / 2;
  const polygon = [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
  addPrism(`wall_${String(wallIndex).padStart(2, '0')}`, polygon, 0.04, wallHeight, 'walls');
  wallIndex += 1;
}

for (const opening of home.openings) {
  const [a, b] = opening.segment;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length < 0.01) continue;
  const nx = (-dy / length) * 0.05;
  const ny = (dx / length) * 0.05;
  const polygon = [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
  const isWindow = opening.kind === 'window';
  addPrism(`opening_${opening.openingId}`, polygon, isWindow ? 0.85 : 0.04, isWindow ? 2.15 : 2.1, isWindow ? 'windows' : 'doors');
}
fs.writeFileSync(path.join(outputDir, 'plan-3d.obj'), `${obj.join('\n')}\n`);

console.log(`Generated plan-2d.svg, plan-3d.obj and plan-3d.mtl in ${outputDir}`);
