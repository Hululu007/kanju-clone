"""导出用于实测的片源样本（脱敏：只输出域名/路径，不输出 query 里的签名）。"""
import sqlite3
import sys

con = sqlite3.connect(sys.argv[1])
c = con.cursor()
out = []
out.append('## failed samples (status, provider, url)')
for title, show_id, ep, prov, kind, st, url, at in c.execute(
    """select s.title, so.show_id, so.ep_idx, so.provider, so.kind, so.status, so.url, so.checked_at
       from sources so join shows s on s.id=so.show_id where so.status!='ok'
       order by so.checked_at desc limit 12"""
):
    out.append(f"{title}\t{prov}\t{kind}\t{st}\t{url}")
out.append('## ok samples (recent, hls)')
for title, show_id, ep, prov, kind, st, url, at in c.execute(
    """select s.title, so.show_id, so.ep_idx, so.provider, so.kind, so.status, so.url, so.checked_at
       from sources so join shows s on s.id=so.show_id where so.status='ok' and so.kind='hls'
       order by so.checked_at desc limit 15"""
):
    out.append(f"{title}\t{prov}\t{kind}\t{st}\t{url}")
out.append('## ok samples (mp4)')
for title, show_id, ep, prov, kind, st, url, at in c.execute(
    """select s.title, so.show_id, so.ep_idx, so.provider, so.kind, so.status, so.url, so.checked_at
       from sources so join shows s on s.id=so.show_id where so.status='ok' and so.kind='mp4'
       order by so.checked_at desc limit 10"""
):
    out.append(f"{title}\t{prov}\t{kind}\t{st}\t{url}")
out.append('## ok by provider/kind')
for prov, kind, n in c.execute(
    "select provider, kind, count(*) as n from sources where status='ok' group by provider, kind order by n desc limit 25"
):
    out.append(f"{prov}\t{kind}\t{n}")
with open(sys.argv[2], 'w', encoding='utf-8') as f:
    f.write('\n'.join(out))
print('wrote', len(out), 'lines')
