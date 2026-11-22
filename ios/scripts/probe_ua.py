"""实测片源在「App 现在的 UA」与「网页浏览器 UA」下的 HTTP 状态差异。

只输出域名与状态码，不打印签名 URL / query / 密钥。
用法：python ios/scripts/probe_ua.py <tsv: title\tprovider\tkind\tstatus\turl> ...
"""
import ssl
import sys
import urllib.request
import urllib.error

APP_UA = 'ZhuijuAI/0.1.19 iOS'          # HLSDownloader 现在真的发这个
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
    rest = url.split('://', 1)[-1]
    return rest.split('/', 1)[0]


def main(paths):
    rows = []
    for path in paths:
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '\t' not in line:
                    continue
                parts = line.split('\t')
                if len(parts) < 5 or not parts[-1].startswith('https://'):
                    continue
                title, provider, kind, st, url = parts[0], parts[1], parts[2], parts[3], parts[-1]
                rows.append((title, provider, kind, st, url))
    print('title | provider | kind | 站点判定 | App UA 现状 | Safari UA+Referer')
    for title, provider, kind, st, url in rows:
        app = status(url, {'User-Agent': APP_UA, 'Referer': REFERER})
        web = status(url, {'User-Agent': SAFARI_UA, 'Referer': REFERER})
        print(f'{title} | {provider} | {kind} | {st} | {app} | {web} | {host(url)}')


if __name__ == '__main__':
    main(sys.argv[1:])
