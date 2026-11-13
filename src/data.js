// Catalogue rebuilt from the visible text of the captured pages.
// [title, category, genres, badge, heat, year]
const RAW = [
  // 电视剧
  ['今天是太阳雨', 'tv', ['国产剧', '剧情'], '更新至第16集', '3.7万', 2026],
  ['谷雨', 'tv', ['税务稽查', '骗税'], '更新至第18集', '3.8万', 2026],
  ['走马上任', 'tv', ['民国', '荒诞'], '更新至第27集', '1.5万', 2026],
  ['折月亮', 'tv', ['社恐', '白月光'], '更新至第18集', '7643', 2026],
  ['后会友期', 'tv', ['友情', '人际疏离'], '2026-11-13 抢鲜版', '1.7万', 2026],
  ['嫁金钗', 'tv', ['古装', '爱情'], '更新至第30集', '1.3万', 2026],
  ['尚公主', 'tv', ['天家嫡女', '寒门才俊'], '更新至第40集', '1.3万', 2026],
  ['小城良方', 'tv', ['都市', '医疗'], '更新至第29集', '5905', 2026],

  // 动漫
  ['沧元图', 'anime', ['奇幻', '动作'], '更新至第103集', '7025', 2023],
  ['斗罗大陆II绝世唐门', 'anime', ['玄幻', '热血'], '更新至第178集', '1.2万', 2026],
  ['大主宰年番', 'anime', ['玄幻', '冒险'], '更新至第99集', '9830', 2026],
  ['罗小黑战记学前篇', 'anime', ['治愈', '奇幻'], '更新至第3集', '4210', 2026],

  // 综艺
  ['现在就出发 第4季', 'variety', ['户外游戏', '真人秀'], '第4季 · 更新至2026-11-13 第6期 特别篇', '1.4万', 2026],
  ['后会友期', 'variety', ['友情', '真人秀'], '更新至2026-11-13 抢鲜版', '1.1万', 2026],
  ['音乐缘计划 第3季', 'variety', ['音乐', '竞演'], '第3季 · 更新至20261106 第1期 上', '6120', 2026],
  ['花儿与少年 第8季', 'variety', ['旅行', '真人秀'], '第8季 · 更新至2026-11-13 第10期 正片', '7380', 2026],

  // 电影
  ['八仙', 'movie', ['奇幻', '古装'], '资源更新', '6890', 2026],
  ['蜘蛛侠:崭新之日', 'movie', ['动作', '科幻'], '资源更新', '5410', 2026],
  ['仙逆剧场版 弑仙之战', 'movie', ['仙侠', '动画'], '资源更新', '4720', 2026],
  ['复活男', 'movie', ['悬疑', '惊悚'], '资源更新', '3580', 2026],

  // 韩剧
  ['我的有罪之人', 'kr', ['改编自小说', '改编自网漫'], '更新至8集 / 共12集', '240', 2026],
  ['末路兼职', 'kr', ['债务缠身', '负债'], '全8集', '215', 2026],
  ['恋爱博士', 'kr', ['游泳运动员', '失去一条腿'], '全12集', '176', 2026],
  ['Doctor X:白色黑手党时代', 'kr', ['医疗', '悬疑'], '更新至10集 / 共12集', '217', 2026],
  ['再婚皇后', 'kr', ['宫廷', '四角恋'], '更新至6集 / 共10集', '203', 2026],
  ['心动制造所', 'kr', ['浪漫喜剧', '性喜剧'], '全10集', '151', 2026],
  ['百日谎言', 'kr', ['扒手', '密探'], '更新至10集 / 共16集', '176', 2026],
  ['中头奖还是要上班', 'kr', ['职场', '办公室'], '全10集', '145', 2026],
  ['恋爱充电中', 'kr', ['奇幻爱情', '浪漫喜剧'], '全10集', '139', 2026],
  ['不是你的恋爱', 'kr', ['恋爱', '婚姻'], '全14集', '141', 2026],

  // 日剧
  ['有人刚好提起我吗', 'jp', ['舞台剧', '演员'], '全8集', '163', 2026],
  ['尤金尼亚之谜', 'jp', ['毒杀', '灭门'], '更新至2集 / 共6集', '150', 2026],
  ['地雷格力高', 'jp', ['学园祭', '青春'], '全6集', '129', 2026],
  ['深夜食堂 第6季', 'jp', ['美食', '治愈'], '更新至4集 / 共10集', '164', 2026],
  ['幸福伽菜子的快乐杀手生活 第2季', 'jp', ['喜剧', '动作'], '全5集', '144', 2026],
  ['欢迎回来,初恋', 'jp', ['初恋', '重逢'], '更新至6集', '138', 2026],
  ['政盗鲁邦', 'jp', ['怪盗', '政治黑金'], '更新至6集', '127', 2026],
  ['豆与麦', 'jp', ['人性剧', '女性友情'], '更新至6集', '96', 2026],
  ['LOST10', 'jp', ['北海道', '登山'], '更新至4集 / 共10集', '101', 2026],
  ['假面美颜', 'jp', ['整形', '整容'], '全8集', '114', 2026],
]

const HUES = [4, 14, 22, 30, 38, 206, 214, 222, 230, 238, 196, 188, 26, 12, 210, 220, 342, 352]

export const CATS = {
  tv: '电视剧',
  anime: '动漫',
  variety: '综艺',
  movie: '电影',
}

export const CAT_KEYS = ['tv', 'anime', 'variety', 'movie']

export const shows = RAW.map((r, i) => {
  const [title, cat, genres, badge, heat, year] = r
  return {
    id: `s${i + 1}`,
    title,
    cat,
    genres,
    badge,
    heat,
    year,
    hue: HUES[i % HUES.length],
    day: (i % 7) + 1,
    seed: i,
  }
})

const byCat = (c) => shows.filter((s) => s.cat === c)

// Day strip: the counts under 本周追剧 for each day of the week.
export const WEEK = [
  { day: 1, label: '周一', date: 9, total: 1003, counts: { tv: 60, anime: 50, variety: 36, movie: 857 } },
  { day: 2, label: '周二', date: 10, total: 1140, counts: { tv: 64, anime: 55, variety: 40, movie: 981 } },
  { day: 3, label: '周三', date: 11, total: 929, counts: { tv: 58, anime: 48, variety: 35, movie: 788 } },
  { day: 4, label: '周四', date: 12, total: 1062, counts: { tv: 70, anime: 60, variety: 42, movie: 890 } },
  { day: 5, label: '周五', date: 13, total: 987, counts: { tv: 86, anime: 70, variety: 44, movie: 787 } },
  { day: 6, label: '周六', date: 14, total: 142, counts: { tv: 14, anime: 12, variety: 8, movie: 108 } },
  { day: 7, label: '周日', date: 15, total: 125, counts: { tv: 12, anime: 10, variety: 7, movie: 96 } },
]

export const TODAY = 5 // 周五 13日

export function weekRange() {
  return '11月9日 - 11月15日'
}

// The small card list beside each category title.
export function categoryItems(cat, day, limit = 4) {
  const pool = byCat(cat)
  const off = (day - TODAY + pool.length) % pool.length
  const out = []
  for (let i = 0; i < limit; i++) out.push(pool[(off + i) % pool.length])
  return out
}

export const catCount = (cat, day) => (WEEK.find((w) => w.day === day) || WEEK[4]).counts[cat]

export const ROWS = [
  {
    id: 'hot',
    title: '大家都在看',
    sub: '今晚打开就能接上的热播片单',
    items: [2, 1, 5, 3, 13, 6, 7, 4, 9, 8].map((n) => shows[n - 1]),
    pool: 'all',
  },
  { id: 'kr', title: '韩剧在追', sub: '从新集开始追也不费劲', items: byCat('kr').slice(0, 10), pool: 'kr' },
  { id: 'jp', title: '日剧上新', sub: '节奏轻一点，夜里慢慢看', items: byCat('jp').slice(0, 10), pool: 'jp' },
]

export const allByPool = (pool) => (pool === 'all' ? shows : byCat(pool))

export function findShow(id) {
  return shows.find((s) => s.id === id) || shows[0]
}

export function episodesFor(show) {
  const m = /第(\d+)集|至(\d+)集/.exec(show.badge)
  const total = m ? Math.max(12, Number(m[1] || m[2]) + 2) : 24
  const n = Math.min(total, 30)
  return Array.from({ length: n }, (_, i) => i + 1)
}
