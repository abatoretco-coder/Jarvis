#!/usr/bin/env python3
import json
import urllib.parse
import urllib.request

env = {}
with open('/opt/naas/stacks/Jarvis/.env') as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, _, v = line.partition('=')
            env[k] = v

payload = urllib.parse.urlencode({
    'client_id': env.get('GOOGLE_CLIENT_ID', ''),
    'client_secret': env.get('GOOGLE_CLIENT_SECRET', ''),
    'refresh_token': env.get('GOOGLE_REFRESH_TOKEN', ''),
    'grant_type': 'refresh_token',
}).encode()

resp = json.loads(urllib.request.urlopen('https://oauth2.googleapis.com/token', payload, timeout=10).read())
token = resp.get('access_token', '')
if not token:
    print('TOKEN_FAIL', resp)
    raise SystemExit(1)

def test_calendar(cal_id: str) -> None:
    params = urllib.parse.urlencode({
        'timeMin': '2026-05-23T22:00:00.000Z',
        'timeMax': '2026-05-30T22:00:00.000Z',
        'singleEvents': 'true',
        'orderBy': 'startTime',
        'maxResults': '10',
    })
    url = f"https://www.googleapis.com/calendar/v3/calendars/{urllib.parse.quote(cal_id, safe='')}/events?{params}"
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token})
    try:
        data = json.loads(urllib.request.urlopen(req, timeout=10).read())
        print(f"OK {cal_id} items={len(data.get('items', []))}")
    except Exception as exc:
        print(f"FAIL {cal_id} {exc}")

for cid in [
    'primary',
    'abatoretco@gmail.com',
    'family10771944489655853150@group.calendar.google.com',
    'a40aae65f3ce47e21be3428716626691685228972d5ea1a07a65abd42c78b5d6@group.calendar.google.com',
    'kgdkom6eoo0fvtv408c0a6lakg@group.calendar.google.com',
]:
    test_calendar(cid)
