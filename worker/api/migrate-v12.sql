-- 100 部验收返修：增量订正 origin_defaults（不重复覆盖其余已确认项）。
-- 依据审核意见 3：只写已确认且实际不同的项；没有原站版本证据的集名撤出，不用本站首集冒充原站默认。
-- 证据：outputs/acceptance-100/origin-ep-evidence-20261122.json（从原站 preview 提取完整集名）+ origin-best-20261122.json。
--
-- no.89 现在就出发 第1季：原站 preview 明确「2023-10-18 第10期 加更」，此前被截成「第10期」误判库缺集；
--   按完整集名在库内匹配到 ep_idx=33，补写集名与索引。
UPDATE origin_defaults SET ep_idx=33, ep_label='2023-10-18 第10期 加更', observed_at='2026-11-22'
 WHERE show_id='av__SDnrWdLrDEmCnDADI4rGowCfHg9gKRjROva7CTOhvQMSJqGoTH7qgIDpCT2LS9A3zznQ2ie9QKrGNw';
--
-- no.71 哪吒之魔童闹海 / no.73 天启Z:新世界：原站 preview 无版本标识（无集名/无抢先版），
--   此前写入的「正片」是本站首集而非原站证据，撤出该集名；线路（红牛资源/西瓜资源）为原站实看，保留。
UPDATE origin_defaults SET ep_idx=NULL, ep_label='', observed_at='2026-11-22'
 WHERE show_id='av_jwK2L7Keh-k_9SkdY6beNq_mypwJL0CJCGBhVr11R5Cf0cZh8ygo7uhB4bDgKqh4_MssN_qcv0sdo8c';
UPDATE origin_defaults SET ep_idx=NULL, ep_label='', observed_at='2026-11-22'
 WHERE show_id='av_P3Z56JLSF1sMAYa5eJdwry7Ck3HjlufGkGsSswZ62GFd8QEWczwDeJIBsOEY1xHHfb73iip5qv0Vxd4';
