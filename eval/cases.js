/**
 * eval/cases.js —— 20 条固定评估用例（契约 §7.3）
 *
 * 覆盖：缺信息（应追问）/ 信息全（应出卡）/ 超纲品类 / 模糊表述 /
 *       多意图 / 知识库覆盖度。
 *
 * 字段说明：
 *   input            用户原话
 *   expect.followup  live 跑批时是否应该追问（离线不校验）
 *   expect.category  期望品类（离线校验检索判定）
 *   expect.refsMin   期望至少有 N 条该品类知识被召回（离线校验）
 *   group            出题人：A / B / C（对应 检索测试 的三组）
 */

const CASES = [
  { id: 'E01', group: 'B', input: '想买个初音手办', expect: { followup: true, category: 'chao_wan', refsMin: 1 } },
  { id: 'E02', group: 'B', input: '想买个初音手办，300以内', expect: { followup: false, category: 'chao_wan', refsMin: 2 } },
  { id: 'E03', group: 'A', input: '推荐个100元内的蓝牙耳机', expect: { followup: false, category: 'digital', refsMin: 2 } },
  { id: 'E04', group: 'C', input: '学妹让我帮她挑面霜', expect: { followup: true, category: 'beauty', refsMin: 1 } },
  { id: 'E05', group: 'C', input: '有没有好用的充电宝啊啊啊啊', expect: { followup: true, category: 'digital', refsMin: 1 } },
  { id: 'E06', group: 'A', input: '6000元想买台写代码的笔记本', expect: { followup: false, category: 'laptop', refsMin: 3 } },
  { id: 'E07', group: 'B', input: '宿舍床垫买多厚的合适', expect: { followup: false, category: 'bed', refsMin: 2 } },
  { id: 'E08', group: 'C', input: '大一新生买教材，二手行不行', expect: { followup: false, category: 'study', refsMin: 2 } },
  { id: 'E09', group: 'C', input: '想买双球鞋，有推荐吗', expect: { followup: true, category: 'universal', refsMin: 0 } },
  { id: 'E10', group: 'A', input: '开学季买电脑会便宜吗', expect: { followup: false, category: 'laptop', refsMin: 1 } },
  { id: 'E11', group: 'B', input: '预算300买什么手办好', expect: { followup: false, category: 'chao_wan', refsMin: 2 } },
  { id: 'E12', group: 'C', input: '敏感肌用什么防晒', expect: { followup: false, category: 'beauty', refsMin: 2 } },
  { id: 'E13', group: 'A', input: '想买个大容量U盘存课件', expect: { followup: false, category: 'digital', refsMin: 2 } },
  { id: 'E14', group: 'B', input: '床上四件套怎么挑', expect: { followup: false, category: 'bed', refsMin: 2 } },
  { id: 'E15', group: 'C', input: '考研教辅买哪一版', expect: { followup: false, category: 'study', refsMin: 2 } },
  { id: 'E16', group: 'A', input: '二手耳机靠谱吗', expect: { followup: false, category: 'digital', refsMin: 2 } },
  { id: 'E17', group: 'A', input: '充电宝能带上飞机吗', expect: { followup: false, category: 'digital', refsMin: 1 } },
  { id: 'E18', group: 'C', input: '想买个平板电脑', expect: { followup: true, category: 'universal', refsMin: 0 } },
  { id: 'E19', group: 'C', input: '相机怎么选', expect: { followup: true, category: 'universal', refsMin: 0 } },
  { id: 'E20', group: 'B', input: '洗衣液哪个牌子好', expect: { followup: true, category: 'universal', refsMin: 0 } }
];

module.exports = { CASES };
