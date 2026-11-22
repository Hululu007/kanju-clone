-- 原站默认集：综艺/剧集除了默认线路，还要对齐原站播放页默认打开的那一集。
-- 2026-11-22 审核反馈：只同步线路、不记录默认集，前端仍取列表第一集，与原站不一致。
-- 电影默认「正片」、剧集默认「第1集」是 2026-11-22 逐部实看原站播放页的结果；
-- 综艺原站默认集（新一期）库里还没有，记 ep_label 用于对照，ep_idx 留空，前端会回退并如实报告未匹配。
ALTER TABLE origin_defaults ADD COLUMN ep_idx INTEGER;
ALTER TABLE origin_defaults ADD COLUMN ep_label TEXT;
UPDATE origin_defaults SET ep_idx=0, ep_label='第1集' WHERE show_id='av_3ALcZ_dI3lZLUiCAI5ClQAVh32DVI4W2Yb6noPY5qmc2d0N22zj1Y8htFnzjNPN12h5vTJ-0rXHcRnY'; -- 尚公主 / 原站默认 第1集
UPDATE origin_defaults SET ep_idx=0, ep_label='第1集' WHERE show_id='av_RQKPHe_swmdc2S67YD_FapUsze6-cWDeerX3qvKoejgyu5YFcUxsh5Hh2wmrcc1iPLCzBGy_VU5KvyQ'; -- 嫁金钗 / 原站默认 第1集
UPDATE origin_defaults SET ep_idx=0, ep_label='第1集' WHERE show_id='av_TtKIVe2dt577SiDSbLVOX4u2rMhPMc4VtGHBtiesmc6HXtExyHPunOjNU7OZ7XA9yPkmCWXDcx4uPXg'; -- 走马上任 / 原站默认 第1集
UPDATE origin_defaults SET ep_idx=0, ep_label='第1集' WHERE show_id='av_j7AzvIxMLgeXuAPp5-B-Dp9yi1sva-q3JKHZ_ZXSuvkktFNyaxK8GjvjgGeFGyWfvGoqEuAfGCkbNKo'; -- 折月亮 / 原站默认 第1集
UPDATE origin_defaults SET ep_idx=NULL, ep_label='2026-11-20 抢鲜版' WHERE show_id='av_11r8C6YQBbEwnXSLgPkpXBr8a6knud-m8Zj5bcSXdcpG8mQ-vMYEC-OmE6GG0wYU8_vDj7_XQCQ98mo'; -- 后会友期
UPDATE origin_defaults SET ep_idx=NULL, ep_label='2026-11-21 第7期 上 情境伪装者纯享' WHERE show_id='av_skkXhxCjWXlnPW1TqzUvMXk1Wt9kM4OegeHFraY8_0NbO6_dYgTy1qyqugPNlLsASa51pSjrF10aKpY'; -- 现在就出发 第4季
UPDATE origin_defaults SET ep_idx=NULL, ep_label='20261121 纯享' WHERE show_id='av_TxqN5yoaAx4awqAbeyPHXuSAMgemNnYHHfKocoHgLZS6ABmTpcWSaR64fsMvbg0EFt_-YEW8zr5MAq8'; -- 音乐缘计划 第3季
UPDATE origin_defaults SET ep_idx=NULL, ep_label='2026-02-01 名场面特辑' WHERE show_id='av_NQ6Tw18Eiuykv1BwCDzhEcdxjsgvMhzGuAeeUx3nL5g_4MrQmCG3wch8xfduVi3K26TfggfYKEK37Zo'; -- 现在就出发 第3季
UPDATE origin_defaults SET ep_idx=0, ep_label='正片' WHERE show_id='av_arm0E0bvF6YIMXgl8nSPiZDkT0mAW9bdgZjvd5BEN0Q8lCuR496o6EGXd9sGF_EUXrwOc-htZoUig98'; -- 八仙 / 原站默认 正片
UPDATE origin_defaults SET ep_idx=0, ep_label='正片' WHERE show_id='av_qiMAZXLo49iYnQ_-NlijAsMD3sU0NsmtSM9JMdV7OaoqT5VMNNUgMszZzNu0qsZPSA1DrwdWpXofkPc'; -- 蜘蛛侠:崭新之日 / 原站默认 正片
UPDATE origin_defaults SET ep_idx=0, ep_label='正片' WHERE show_id='av_VD97eiVmcqY_sAQ9nG_eQih6GIRYKed77nxDjcmnI4xJA4vy8Vv2XV9VIezdpKB9A_YchEswUDPYy4k'; -- 空枪 / 原站默认 正片
UPDATE origin_defaults SET ep_idx=0, ep_label='正片' WHERE show_id='av_tjTpuU6TfuUhn2pOmS7agsC4lKlxMmcwdYL4UKSa-AuMrHLKhxtRsCtq48YLL88j99tu5pbArjQpuy8'; -- 奥德赛 / 原站默认 正片
-- 多语言版本：把对照表标签写成库内同名变体，避免按 provider 落到排序第一条（粤语/英语）
UPDATE origin_defaults SET ep_label='正片', label='1080P-官方V · 普通话' WHERE show_id='av_arm0E0bvF6YIMXgl8nSPiZDkT0mAW9bdgZjvd5BEN0Q8lCuR496o6EGXd9sGF_EUXrwOc-htZoUig98';
UPDATE origin_defaults SET ep_label='正片', label='1080P-官方Z · 英语' WHERE show_id='av_qiMAZXLo49iYnQ_-NlijAsMD3sU0NsmtSM9JMdV7OaoqT5VMNNUgMszZzNu0qsZPSA1DrwdWpXofkPc';
UPDATE origin_defaults SET ep_label='正片', label='高清-官方B · 英语' WHERE show_id='av_tjTpuU6TfuUhn2pOmS7agsC4lKlxMmcwdYL4UKSa-AuMrHLKhxtRsCtq48YLL88j99tu5pbArjQpuy8';
