#!/usr/bin/env python3
"""
List all Google Calendar IDs available with the configured OAuth credentials.
Also verifies that the calendar scope is present on the current refresh token.
"""
import json
import urllib.request
import urllib.parse

env = {}
with open('/opt/naas/stacks/Jarvis/.env') as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, _, v = line.partition('=')
            env[k] = v

data = urllib.parse.urlencode({
    'client_id': env.get('GOOGLE_CLIENT_ID', ''),
    'client_secret': env.get('GOOGLE_CLIENT_SECRET', ''),
    'refresh_token': env.get('GOOGLE_REFRESH_TOKEN', ''),
    'grant_type': 'refresh_token'
}).encode()

req = urllib.request.Request('https://oauth2.googleapis.com/token', data=data)
resp = json.loads(urllib.request.urlopen(req, timeout=10).read())
token = resp.get('access_token', '')

if not token:
    print('TOKEN_FAILED:', json.dumps(resp, indent=2))
    exit(1)

req2 = urllib.request.Request(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList',
    headers={'Authorization': 'Bearer ' + token}
)
items = json.loads(urllib.request.urlopen(req2, timeout=10).read()).get('items', [])

print(f"\n{'='*60}")
print(f"  {len(items)} calendriers disponibles")
print(f"{'='*60}\n")
for i in items:
    tag = '[PRIMARY] ' if i.get('primary') else '           '
    role = i.get('accessRole', '')
    print(f"{tag}{i['summary']}")
    print(f"           ID     : {i['id']}")
    print(f"           Role   : {role}")
    print()
