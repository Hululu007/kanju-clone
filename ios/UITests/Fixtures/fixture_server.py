#!/usr/bin/env python3
"""受控夹具站：XCUITest 在没有账号、不连公网时要真点一遍播放页。

只做三件事：

1. 静态文件（`index.html` / `player/index.html` / `media/*.mp4`）；
2. `/api/play?show=&ep=&line=` 返回这一集的真实片源地址（批量下载要校验它）；
3. 视频请求支持 `Range`：AVPlayer / WKWebView 会先要 `bytes=0-1` 探一次，
   不支持 Range 的服务器在真模拟器里会让播放和下载都卡住。

用 `--root` 指定站点目录，`--port` 指定端口（默认 8765）。
"""

import argparse
import json
import mimetypes
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

MEDIA_ROUTE = "/media/fixture.mp4"


class FixtureHandler(BaseHTTPRequestHandler):
    root = "."
    server_version = "ZhuijuFixture/1.0"

    def log_message(self, fmt, *args):  # noqa: A003 - 覆盖基类签名
        sys.stderr.write("fixture %s - %s\n" % (self.address_string(), fmt % args))

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - 基类命名
        parsed = urlparse(self.path)
        route = parsed.path

        if route == "/api/play":
            query = parse_qs(parsed.query)
            ep = (query.get("ep", ["1"])[0] or "1").strip()
            show = (query.get("show", ["demo"])[0] or "demo").strip()
            line = (query.get("line", ["1"])[0] or "1").strip()
            base = "http://%s:%d" % (self.headers.get("Host", "127.0.0.1").split(":")[0], self.server.server_port)
            media = base + MEDIA_ROUTE
            # 站点 /api/play 的形状在不同版本里叫法不一样：把常见别名都给出去，
            # 注入层只要认得其中一个就能解析到真实地址（不猜、不伪造其它字段）。
            return self._json({
                "code": 0,
                "url": media,
                "media": media,
                "src": media,
                "show": show,
                "showId": show,
                "ep": ep,
                "idx": int(re.sub(r"\D", "", ep) or 0),
                "line": line,
                "verified": True,
                "type": "mp4",
                "data": {
                    "url": media, "media": media, "src": media,
                    "show": show, "showId": show, "ep": ep,
                    "idx": int(re.sub(r"\D", "", ep) or 0), "line": line,
                    "verified": True, "type": "mp4",
                },
            })

        # 站点首页/播放页的友好路由
        candidates = [route]
        if route.endswith("/"):
            candidates.append(route + "index.html")
        if route in ("/", ""):
            candidates = ["/index.html"]
        for candidate in candidates:
            full = os.path.normpath(os.path.join(self.root, candidate.lstrip("/")))
            if not full.startswith(os.path.abspath(self.root)):
                continue
            if os.path.isfile(full):
                return self._serve_file(full)

        self.send_response(404)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(("not found: %s\n" % route).encode("utf-8"))

    def _serve_file(self, full):
        size = os.path.getsize(full)
        content_type = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if full.endswith(".m3u8"):
            content_type = "application/vnd.apple.mpegurl"
        range_header = self.headers.get("Range")
        start, end = 0, size - 1
        status = 200
        if range_header:
            match = re.match(r"bytes=(\d*)-(\d*)", range_header.strip())
            if match:
                if match.group(1):
                    start = int(match.group(1))
                if match.group(2):
                    end = min(int(match.group(2)), size - 1)
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % size)
                    self.end_headers()
                    return
                status = 206

        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        with open(full, "rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining > 0:
                chunk = handle.read(min(65536, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--bind", default="127.0.0.1")
    args = parser.parse_args()
    FixtureHandler.root = os.path.abspath(args.root)
    server = ThreadingHTTPServer((args.bind, args.port), FixtureHandler)
    sys.stderr.write("fixture site %s on http://%s:%d\n" % (FixtureHandler.root, args.bind, args.port))
    sys.stderr.flush()
    server.serve_forever()


if __name__ == "__main__":
    main()
