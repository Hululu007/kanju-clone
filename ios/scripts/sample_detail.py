# -*- coding: utf-8 -*-
"""给报告生成「3 部真实失败样本」的脱敏明细（不含签名 URL）。"""
import sqlite3
import sys

con = sqlite3.connect(sys.argv[1])
c = con.cursor()
targets = ['谷雨', '倾世锦鳞谷雨来', '古玉劫后香', '金牌调解']
out = []
for title in targets:
    rows = c.execute(
        """select s.id, s.episode_count, s.available_episode_count from shows s where s.title=? limit 3""",
        (title,),
    ).fetchall()
    if not rows:
        out.append(f'## {title}: 库里没有同名剧')
        continue
    for sid, ep_count, avail in rows[:1]:
        out.append(f'## {title}  show={sid[:24]}…  集数={ep_count}  可播集={avail}')
        for prov, kind, st, n in c.execute(
            """select provider, kind, status, count(*) n from sources
               where show_id=? group by provider, kind, status order by n desc""",
            (sid,),
        ):
            out.append(f'   - {prov} | {kind} | {st} | {n} 集')
with open(sys.argv[2], 'w', encoding='utf-8') as f:
    f.write('\n'.join(out))
print('lines', len(out))
