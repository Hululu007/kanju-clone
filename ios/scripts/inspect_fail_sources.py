"""离线盘点：从站点数据库里挑真实下不了的片源样本（脱敏输出，不含签名参数）。

用法：python ios/scripts/inspect_fail_sources.py <kanju.db>
只读副本，不碰线上库。
"""
import sqlite3
import sys
from urllib.parse import urlsplit

def redact(url):
    u = urlsplit(url or '')
    path = u.path
    if len(path) > 50:
        path = path[:50] + '...'
    return f"{u.scheme}://{u.netloc}{path}"

def main(db_path):
    con = sqlite3.connect(db_path)
    c = con.cursor()
    rows = c.execute(
        """select s.title, so.show_id, so.ep_idx, so.provider, so.kind, so.status, so.url, so.checked_at
           from sources so join shows s on s.id = so.show_id
           where so.status != 'ok' order by so.checked_at desc"""
    ).fetchall()
    print('failed rows:', len(rows))
    seen = set()
    for title, show_id, ep, prov, kind, st, url, at in rows:
        key = (title, prov, st)
        if key in seen:
            continue
        seen.add(key)
        print(f"{title} | show={show_id} ep={ep} | {prov} | {kind} | {st} | {redact(url)} | {at}")
        if len(seen) >= 40:
            break
    print('--- kinds per provider for ok sources (top)')
    for prov, kind, n in c.execute(
        "select provider, kind, count(*) from sources where status='ok' group by provider, kind order by n desc limit 25"
    ):
        print(prov, kind, n)
    print('--- http vs https among ok sources')
    for (scheme, n) in c.execute(
        "select substr(url,1,instr(url,':')-1) s, count(*) from sources where status='ok' group by s"
    ):
        print(scheme, n)

if __name__ == '__main__':
    main(sys.argv[1])
