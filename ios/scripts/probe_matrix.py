"""同一批真实片源 × 三种请求头，比较 HTTP 状态（只打印域名/状态，不含签名）。"""
import ssl
import sqlite3
import sys
import urllib.error
import urllib.request

APP_UA = 'ZhuijuAI/0.1.19 iOS'
SAFARI_UA = ('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
             'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')
REFERER = 'https://zhuiju.dpdns.org/'
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def status(url, headers):
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15, context=CTX) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:
        return type(e).__name__


def host(url):
    return url.split('://', 1)[-1].split('/', 1)[0]


con = sqlite3.connect(sys.argv[1])
rows = con.execute(
    """select s.title, so.provider, so.kind, so.status, so.url from sources so
       join shows s on s.id=so.show_id
       where so.status='ok' and so.kind='hls' and so.url like 'https://%'
       group by so.provider order by so.checked_at desc limit 14"""
).fetchall()
rows += con.execute(
    """select s.title, so.provider, so.kind, so.status, so.url from sources so
       join shows s on s.id=so.show_id
       where so.status!='ok' and so.url like 'https://%'
       group by so.provider, so.status order by so.checked_at desc limit 12"""
).fetchall()

print('title | provider | kind | db | no-UA | App-UA | Safari-UA+Referer | host')
for title, prov, kind, st, url in rows:
    plain = status(url, {})
    app = status(url, {'User-Agent': APP_UA, 'Referer': REFERER})
    web = status(url, {'User-Agent': SAFARI_UA, 'Referer': REFERER})
    print(f'{title} | {prov} | {kind} | {st} | {plain} | {app} | {web} | {host(url)}')
