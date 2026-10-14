import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { liveBaseUrl, liveOwnerTokens, logoutLiveOwner } from './live-e2e-auth';

type HassState = {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
};

type Room = {
  roomId: string;
  name: string;
  devices: Array<{ deviceId: string; entityId: string }>;
};

const container = process.env.E2E_LIVE_JARVIS_CONTAINER ?? 'jarvis-pc-jarvis-1';
const rooms: Room[] = [
  {
    roomId: 'room_living',
    name: 'Séjour',
    devices: [
      { deviceId: 'hue-living-ceiling-1', entityId: 'light.plafonnier_salon_centre' },
      { deviceId: 'hue-living-ceiling-2', entityId: 'light.plafonnier_salon_couloir' },
      { deviceId: 'tapo-plug-1', entityId: 'switch.prise_lampe' },
      { deviceId: 'tapo-plug-2', entityId: 'switch.prise_lampe_salon' },
    ],
  },
  {
    roomId: 'room_kitchen',
    name: 'Cuisine',
    devices: [{ deviceId: 'hue-kitchen-ceiling', entityId: 'light.plafonnier_cuisine' }],
  },
  {
    roomId: 'room_bedroom',
    name: 'Chambre',
    devices: [{ deviceId: 'hue-bedroom-ceiling', entityId: 'light.plafonnier_chambre' }],
  },
  {
    roomId: 'room_bathroom',
    name: 'Salle de bain',
    devices: [
      { deviceId: 'hue-bathroom-spot-1', entityId: 'light.spot_salle_de_bain_1' },
      { deviceId: 'hue-bathroom-spot-2', entityId: 'light.spot_salle_de_bain_2' },
    ],
  },
  {
    roomId: 'room_office',
    name: 'Bureau',
    devices: [{ deviceId: 'hue-office-light', entityId: 'light.lampe_bureau' }],
  },
];

const entityIds = rooms.flatMap((room) => room.devices.map((device) => device.entityId));

function inJarvis(script: string, env: Record<string, string> = {}): string {
  const args = ['exec'];
  for (const [name, value] of Object.entries(env)) args.push('-e', `${name}=${value}`);
  args.push(container, 'node', '-e', script);
  return execFileSync('docker', args, { encoding: 'utf8', windowsHide: true }).trim();
}

function hassStates(): HassState[] {
  const ids = Buffer.from(JSON.stringify(entityIds), 'utf8').toString('base64');
  return JSON.parse(inJarvis(
    "const ids=JSON.parse(Buffer.from(process.env.IDS,'base64').toString('utf8'));fetch(process.env.HA_BASE_URL+'/api/states',{headers:{Authorization:'Bearer '+process.env.HA_TOKEN}}).then(r=>r.json()).then(s=>console.log(JSON.stringify(s.filter(x=>ids.includes(x.entity_id))))).catch(e=>{console.error(e);process.exit(1)})",
    { IDS: ids }
  )) as HassState[];
}

function restoreHassStates(states: HassState[]): void {
  const snapshot = Buffer.from(JSON.stringify(states), 'utf8').toString('base64');
  inJarvis(
    "const states=JSON.parse(Buffer.from(process.env.SNAPSHOT,'base64').toString('utf8'));const base=process.env.HA_BASE_URL;const h={Authorization:'Bearer '+process.env.HA_TOKEN,'Content-Type':'application/json'};async function call(d,s,b){const r=await fetch(base+'/api/services/'+d+'/'+s,{method:'POST',headers:h,body:JSON.stringify(b)});if(!r.ok)throw new Error(d+'.'+s+':'+r.status)};(async()=>{for(const x of states){const d=x.entity_id.split('.')[0];if(x.state!=='on'){await call(d,'turn_off',{entity_id:x.entity_id});continue}const b={entity_id:x.entity_id};if(d==='light'){if(x.attributes.brightness!=null)b.brightness=x.attributes.brightness;if(x.attributes.color_temp_kelvin!=null)b.color_temp_kelvin=x.attributes.color_temp_kelvin;else if(Array.isArray(x.attributes.hs_color))b.hs_color=x.attributes.hs_color}await call(d,'turn_on',b)}})().catch(e=>{console.error(e);process.exit(1)})",
    { SNAPSHOT: snapshot }
  );
}

function byId(states: HassState[]): Map<string, HassState> {
  return new Map(states.map((state) => [state.entity_id, state]));
}

function brightnessPercent(state: HassState | undefined): number | undefined {
  const value = state?.attributes.brightness;
  return typeof value === 'number' ? Math.round((value / 255) * 100) : undefined;
}

async function main(): Promise<void> {
  if (process.env.E2E_LIVE_CONFIRM !== 'production') {
    throw new Error('Set E2E_LIVE_CONFIRM=production to run reversible live lighting actions.');
  }
  const initial = hassStates();
  const initialById = byId(initial);
  const tokens = await liveOwnerTokens();
  const baseUrl = liveBaseUrl();
  const filmOnly = process.env.E2E_LIGHTING_FILM_ONLY === 'true';
  const headers = {
    authorization: `Bearer ${tokens.access_token}`,
    'content-type': 'application/json',
  };
  const results: Array<Record<string, unknown>> = [];

  const json = async (response: Response): Promise<Record<string, unknown>> => {
    const body = await response.text();
    const parsed = body ? JSON.parse(body) as Record<string, unknown> : {};
    if (!response.ok) throw new Error(`http_${response.status}:${body.slice(0, 300)}`);
    return parsed;
  };

  try {
    const home = await json(await fetch(`${baseUrl}/v1/home`, { headers }));
    const devices = Array.isArray(home.devices) ? home.devices as Array<{ deviceId?: string }> : [];
    const thirdPlugHidden = !devices.some((device) => device.deviceId === 'tapo-plug-3');
    results.push({ id: 'catalog.disconnected_plug_hidden', ok: thirdPlugHidden });

    for (const room of filmOnly ? [] : rooms) {
      const existing = room.devices.filter((device) => initialById.has(device.entityId));
      if (!existing.length) {
        results.push({ id: `off.${room.roomId}`, room: room.name, ok: false, reason: 'no_available_entity' });
        continue;
      }
      try {
        const response = await json(await fetch(`${baseUrl}/v1/home/lighting/rooms/${room.roomId}/mode`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ mode: 'off' }),
        }));
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const after = byId(hassStates());
        const off = existing.every((device) => after.get(device.entityId)?.state === 'off');
        results.push({
          id: `off.${room.roomId}`,
          room: room.name,
          ok: off,
          operationStatus: response.operationStatus,
          failedDeviceIds: response.failedDeviceIds,
        });
      } catch (error) {
        results.push({
          id: `off.${room.roomId}`,
          room: room.name,
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        restoreHassStates(initial);
        const clearingDevice = existing[0];
        const original = initialById.get(clearingDevice.entityId);
        if (original) {
          await json(await fetch(`${baseUrl}/v1/home/actions`, {
            method: 'POST',
            headers: { ...headers, 'idempotency-key': `lighting-e2e-clear-${randomUUID()}` },
            body: JSON.stringify({
              deviceId: clearingDevice.deviceId,
              action: original.state === 'on' ? 'turn_on' : 'turn_off',
            }),
          })).catch(() => undefined);
          restoreHassStates(initial);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }

    const beforeFilm = byId(hassStates());
    const film = await json(await fetch(`${baseUrl}/v1/home/scenes/film/run`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': `lighting-e2e-film-${randomUUID()}` },
      body: '{}',
    }));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const afterFilm = byId(hassStates());
    const unchangedRoomIds = ['room_kitchen', 'room_bedroom', 'room_bathroom'];
    const untouchedDifferences = rooms
      .filter((room) => unchangedRoomIds.includes(room.roomId))
      .flatMap((room) => room.devices)
      .flatMap((device) => {
        const before = beforeFilm.get(device.entityId);
        const after = afterFilm.get(device.entityId);
        return before?.state === after?.state && brightnessPercent(before) === brightnessPercent(after)
          ? []
          : [{
              entityId: device.entityId,
              before: { state: before?.state, brightness: brightnessPercent(before) },
              after: { state: after?.state, brightness: brightnessPercent(after) },
            }];
      });
    const untouched = untouchedDifferences.length === 0;
    const livingFilmOk = afterFilm.get('switch.prise_lampe')?.state === 'on'
      && afterFilm.get('switch.prise_lampe_salon')?.state === 'off'
      && afterFilm.get('light.plafonnier_salon_centre')?.state === 'on'
      && afterFilm.get('light.plafonnier_salon_couloir')?.state === 'on'
      && Math.abs((brightnessPercent(afterFilm.get('light.plafonnier_salon_centre')) ?? -100) - 10) <= 2
      && Math.abs((brightnessPercent(afterFilm.get('light.plafonnier_salon_couloir')) ?? -100) - 10) <= 2
      && untouched;
    results.push({
      id: 'scene.film.living_and_isolation',
      ok: livingFilmOk,
      operationStatus: film.operationStatus ?? film.status,
      failedDeviceIds: film.failedDeviceIds,
      livingBrightness: [
        brightnessPercent(afterFilm.get('light.plafonnier_salon_centre')),
        brightnessPercent(afterFilm.get('light.plafonnier_salon_couloir')),
      ],
      untouchedOtherRooms: untouched,
      untouchedDifferences,
    });
    const office = afterFilm.get('light.lampe_bureau');
    results.push({
      id: 'scene.film.office',
      ok: office?.state === 'on' && Math.abs((brightnessPercent(office) ?? -100) - 8) <= 2,
      state: office?.state ?? 'missing',
      brightness: brightnessPercent(office),
    });
  } finally {
    restoreHassStates(initial);
    await logoutLiveOwner(tokens).catch(() => undefined);
  }

  process.stdout.write(`LIGHTING_LIVE_SUMMARY ${JSON.stringify({
    passed: results.filter((result) => result.ok === true).length,
    total: results.length,
    results,
  })}\n`);
  if (results.some((result) => result.ok !== true)) process.exitCode = 1;
}

void main().catch((error) => {
  process.stderr.write(`LIGHTING_LIVE_FATAL ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
