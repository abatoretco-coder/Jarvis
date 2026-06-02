"""
One-shot script to get a Google refresh token with mail + calendar scopes.
Usage: python get_google_refresh_token.py
"""
import http.server
import json
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser

CLIENT_ID     = '935535791230-r7sal92um9m3oa48snhc6poh1je52ji7.apps.googleusercontent.com'
PORT          = 9876
REDIRECT_URI  = f'http://localhost:{PORT}'
SCOPES        = 'https://mail.google.com/ https://www.googleapis.com/auth/calendar'

CLIENT_SECRET = input('Client secret (depuis .env sur VM400): ').strip()

auth_url = (
    'https://accounts.google.com/o/oauth2/auth'
    f'?client_id={urllib.parse.quote(CLIENT_ID)}'
    f'&redirect_uri={urllib.parse.quote(REDIRECT_URI)}'
    '&response_type=code'
    f'&scope={urllib.parse.quote(SCOPES)}'
    '&access_type=offline&prompt=consent'
)

code_holder: dict = {}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        code_holder['code'] = qs.get('code', [None])[0]
        self.send_response(200)
        self.end_headers()
        self.wfile.write('<h1>Autorisation OK - tu peux fermer cet onglet.</h1>'.encode('utf-8'))
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def log_message(self, *args):
        pass


srv = http.server.HTTPServer(('localhost', PORT), Handler)
print(f'\nOuverture du navigateur pour autorisation...\n')
webbrowser.open(auth_url)
print('En attente du callback Google sur http://localhost:9876 ...')
srv.serve_forever()

code = code_holder.get('code')
if not code:
    print('Aucun code recu — abandon.')
    sys.exit(1)

print('Code recu, echange contre refresh_token...')
data = urllib.parse.urlencode({
    'code':          code,
    'client_id':     CLIENT_ID,
    'client_secret': CLIENT_SECRET,
    'redirect_uri':  REDIRECT_URI,
    'grant_type':    'authorization_code',
}).encode()

resp = json.loads(
    urllib.request.urlopen('https://oauth2.googleapis.com/token', data, timeout=10).read()
)

rt = resp.get('refresh_token', '')
if rt:
    print(f'\n{"="*60}')
    print('NOUVEAU REFRESH TOKEN (mail + calendar) :')
    print(f'{"="*60}')
    print(rt)
    print(f'{"="*60}')
    print('\nMets a jour GOOGLE_REFRESH_TOKEN dans /opt/naas/stacks/Jarvis/.env')
    print('puis : ssh loic@192.168.1.38 "cd /opt/naas/stacks/home-assistant && docker compose up -d jarvis"')
else:
    print('Erreur lors de lechange:', json.dumps(resp, indent=2))
