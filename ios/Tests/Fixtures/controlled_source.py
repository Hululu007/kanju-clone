#!/usr/bin/env python3
"""CI 用的「受控慢速片源」：进程外跑，给真实的后台 URLSession 任务喂字节。

为什么要进程外：
    0.1.14 的暂停/继续竞态测试原本在 XCTest 宿主进程里用 NWListener 监听回环。
    iOS 14+ 的本地网络隐私（Local Network）会拦截**外部对 App 自身监听 socket 的入站连接**，
    失败日志里就是 `nw_listener_socket_inbox_create_socket setsockopt SO_NECP_LISTENUUID failed`
    紧跟着 20 秒 received=0。把它挪到进程外（本文件由 CI 直接启动）之后，
    连接方是系统的 nsurlsessiond，和对 python3 -m http.server 8765 的既有绿色用法完全一致。

这个源的行为（测试需要可预测的「running 且有字节」状态）：
    - 先回完整响应头 + 64KB 首块，保证任务立刻进入 running 并收到真实字节；
    - 之后每 0.5 秒再吐 8KB，任务一直保持 running（不会提前完成，也不会立刻超时）；
    - `/norange-*.mp4`：不支持 Range（不回 Accept-Ranges/Content-Range，永远 200），
      系统给不出 resumeData，用来验证「拿不到续传数据也必须能从 0 重来」。
    - `/health`：给测试一个廉价的可达性探针。

用法（CI 里由 .github/workflows/ios-unsigned.yml 启动）：
    python3 Tests/Fixtures/controlled_source.py --port 8766
"""

import argparse
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOTAL = 2_000_000
FIRST_CHUNK = 64_000
TRICKLE = 8 * 1024
TRICKLE_INTERVAL = 0.5
MAX_SECONDS = 120


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 让 CI 日志里能看到真实请求
        sys.stdout.write("[controlled-source] " + (fmt % args) + "\n")
        sys.stdout.flush()

    def do_GET(self):  # noqa: N802 (http.server API)
        path = self.path.split("?", 1)[0]
        if path == "/health":
            body = b"ok"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        norange = path.startswith("/norange")
        start = 0
        if not norange:
            header = self.headers.get("Range") or ""
            if header.startswith("bytes="):
                try:
                    start = int(header.split("=", 1)[1].split("-", 1)[0])
                except ValueError:
                    start = 0
        start = max(0, min(start, TOTAL - 1))
        remaining = TOTAL - start

        if norange:
            self.send_response(200)
        else:
            self.send_response(206 if start else 200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(remaining))
        if not norange:
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("ETag", '"kanju-controlled-v1"')
            if start:
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, TOTAL - 1, TOTAL))
        self.send_header("Connection", "close")
        self.end_headers()

        chunk = bytes([7]) * min(FIRST_CHUNK, remaining)
        sent = 0
        deadline = time.monotonic() + MAX_SECONDS
        try:
            self.wfile.write(chunk)
            self.wfile.flush()
            sent += len(chunk)
            # 首块之后慢慢吐：任务保持 running，测试自己决定 pause / resume / cancel
            while sent < remaining and time.monotonic() < deadline:
                time.sleep(TRICKLE_INTERVAL)
                piece = bytes([7]) * min(TRICKLE, remaining - sent)
                self.wfile.write(piece)
                self.wfile.flush()
                sent += len(piece)
        except (BrokenPipeError, ConnectionResetError):
            # 客户端暂停/取消（正常路径）：本连接到此为止
            self.log_message("client closed after %d bytes (%s)", sent, path)
            return
        self.close_connection = True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    sys.stdout.write("[controlled-source] listening on 127.0.0.1:%d\n" % args.port)
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
