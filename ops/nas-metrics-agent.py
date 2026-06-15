#!/usr/bin/env python3
import json
import os
import socket
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


TOKEN = os.environ.get("NAS_METRICS_TOKEN", "")
HOST = os.environ.get("NAS_METRICS_HOST", "0.0.0.0")
PORT = int(os.environ.get("NAS_METRICS_PORT", "9108"))
MOUNTS = [item for item in os.environ.get("NAS_METRICS_MOUNTS", "/,/mnt/tank-data").split(",") if item]
PROTOCOLS = {
    "ssh": 22,
    "nfs": 2049,
    "plex": 32400,
    "syncthing": 22000,
    "ollama": 11434,
}


def read_meminfo():
    values = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        key, raw = line.split(":", 1)
        values[key] = int(raw.strip().split()[0]) * 1024
    return values


def percent_used(total, available):
    return round((1 - available / total) * 100, 1) if total else 0.0


def listening(port):
    for family in (socket.AF_INET, socket.AF_INET6):
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.settimeout(0.12)
        try:
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                return True
        finally:
            sock.close()
    return False


def temperatures():
    result = []
    for path in Path("/sys/class/hwmon").glob("hwmon*/temp*_input"):
        try:
            value = float(path.read_text().strip()) / 1000
            if -20 <= value <= 150:
                result.append({"label": path.parent.name, "celsius": round(value, 1)})
        except (OSError, ValueError):
            pass
    return result


def snapshot():
    mem = read_meminfo()
    total = mem.get("MemTotal", 0)
    available = mem.get("MemAvailable", 0)
    swap_total = mem.get("SwapTotal", 0)
    swap_free = mem.get("SwapFree", 0)
    filesystems = []
    for mount in MOUNTS:
        try:
            stats = os.statvfs(mount)
            fs_total = stats.f_blocks * stats.f_frsize
            fs_available = stats.f_bavail * stats.f_frsize
            filesystems.append({
                "mount": mount,
                "totalBytes": fs_total,
                "availableBytes": fs_available,
                "usedPercent": percent_used(fs_total, fs_available),
            })
        except OSError:
            pass
    load = os.getloadavg()
    return {
        "hostname": socket.gethostname(),
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "uptimeSeconds": int(float(Path("/proc/uptime").read_text().split()[0])),
        "load": {"one": load[0], "five": load[1], "fifteen": load[2]},
        "memory": {
            "totalBytes": total,
            "availableBytes": available,
            "usedPercent": percent_used(total, available),
        },
        "swap": {
            "totalBytes": swap_total,
            "freeBytes": swap_free,
            "usedPercent": percent_used(swap_total, swap_free),
        },
        "filesystems": filesystems,
        "temperatures": temperatures(),
        "protocols": [
            {"name": name, "port": port, "available": listening(port)}
            for name, port in PROTOCOLS.items()
        ],
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/status":
            self.send_error(404)
            return
        if not TOKEN or self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self.send_error(401)
            return
        payload = json.dumps(snapshot(), separators=(",", ":")).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args):
        return


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
