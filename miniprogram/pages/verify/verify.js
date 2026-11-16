const aiClient = require('../../services/aiClient');

function normalizeSources(list) {
  return (Array.isArray(list) ? list : [])
    .map((s) => (s && (s.site_name || s.name)) || '')
    .filter(Boolean);
}

const VERIFY_META_CLAUSE = /(?:检索|搜索|网页)(?:结果|范围|覆盖)|结果以.*为主|缺少|缺乏|未覆盖|未检索|未找到|没有检索|无法核实|未能核实|无法验证|未呈现|未提(?!供)[^，。；]{0,12}(?:问题|反馈|评价|口碑|售后|品控)|无用户|没有用户|无具体|没有具体|信息缺失|口碑暂缺|属(?:于)?(?:媒体|行业|规格|品类)|非口碑|仅为|只是(?:规格|资料|媒体|行业)/;

function cleanVerifyText(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const clauses = text
    .split(/[，。；！？\n]+/)
    .map((x) => x.trim())
    .filter((x) => x && !VERIFY_META_CLAUSE.test(x));
  return clauses.length ? clauses.join('，') + '。' : '';
}

function cleanVerifyContent(content) {
  const c = content || {};
  return {
    verdict: cleanVerifyText(c.verdict),
    feedback: (Array.isArray(c.feedback) ? c.feedback : []).map(cleanVerifyText).filter(Boolean),
    caution: cleanVerifyText(c.caution)
  };
}

function buildSearchOptions(keyword) {
  const base = String(keyword || '').trim().replace(/(?:\s*(?:使用体验|优缺点|质量品控|售后服务))+$/, '').trim();
  if (!base) return [];
  return ['使用体验', '优缺点', '质量品控', '售后服务'].map((label) => {
    const suffix = ' ' + label;
    const keepLength = Math.max(1, 30 - suffix.length);
    return { label, query: base.slice(0, keepLength).trim() + suffix };
  });
}

function needsSearchOptions(summary) {
  const s = summary || {};
  const feedback = Array.isArray(s.community_feedback) ? s.community_feedback.join(' ') : '';
  const text = [s.recent_verdict, feedback, s.caution_alert].join(' ');
  return /未检索到|暂未检索到|没有检索到|口碑暂缺|信息缺失|同系列通用参考|品类通用观察|(?:无|没有)[^，。；]{0,24}(?:具体型号|独立评测|口碑)/.test(text);
}

Page({
  data: {
    keyword: '',
    loading: false,
    stageText: '正在检索全网口碑…',
    state: 'idle', // idle | loading | done | empty | degraded
    verdict: '',
    feedback: [],
    caution: '',
    sources: [],
    errorCode: '',
    showSearchOptions: false,
    searchOptions: []
  },

  onLoad(query) {
    const kw = query && query.kw ? decodeURIComponent(query.kw) : '';
    if (kw) this.setData({ keyword: String(kw).slice(0, 30) });
  },

  onInput(e) {
    this.setData({
      keyword: String(e.detail.value || '').slice(0, 30),
      showSearchOptions: false,
      searchOptions: []
    });
  },

  onSearchOptionTap(e) {
    const query = String((e.currentTarget.dataset && e.currentTarget.dataset.query) || '').slice(0, 30);
    if (!query || this.data.loading) return;
    this.setData({ keyword: query }, () => this.onSubmit());
  },

  async onSubmit() {
    if (this.data.loading) return;
    const keyword = String(this.data.keyword || '').trim();
    if (!keyword) {
      wx.showToast({ title: '先写个品类或型号', icon: 'none' });
      return;
    }

    this.setData({
      loading: true,
      stageText: '正在检索全网口碑…',
      state: 'loading',
      verdict: '',
      feedback: [],
      caution: '',
      sources: [],
      errorCode: '',
      showSearchOptions: false,
      searchOptions: []
    });

    let res = null;
    try {
      res = await aiClient.verify({
        searchKeyword: keyword,
        cardTitle: '',
        stream: true,
        onStage: (s) => {
          if (!this.data.loading) return;
          this.setData({
            stageText: s && s.stage === 'writing' ? '正在生成评价…' : '正在检索全网口碑…'
          });
        },
        onPreview: (pv) => {
          if (!this.data.loading) return;
          const content = cleanVerifyContent(pv);
          this.setData(content);
        }
      });
    } catch (e) {
      res = { status: 'degraded', error_code: (e && e.code) || 'E_UNKNOWN', search_summary: {} };
    }

    const summary = (res && res.search_summary) || {};
    const status = (res && res.status) || 'degraded';

    if (status === 'success') {
      const content = cleanVerifyContent({
        verdict: summary.recent_verdict,
        feedback: summary.community_feedback,
        caution: summary.caution_alert
      });
      const hasContent = !!(content.verdict || content.feedback.length || content.caution);
      const showSearchOptions = !hasContent || needsSearchOptions(summary);
      this.setData({
        loading: false,
        state: hasContent ? 'done' : 'empty',
        verdict: hasContent ? content.verdict || '已找到的公开信息如下。' : '',
        feedback: content.feedback,
        caution: content.caution,
        sources: normalizeSources(res.sources),
        showSearchOptions,
        searchOptions: showSearchOptions ? buildSearchOptions(keyword) : []
      });
      return;
    }

    const isEmpty = status === 'empty';
    this.setData({
      loading: false,
      state: isEmpty ? 'empty' : 'degraded',
      errorCode: (res && res.error_code) || '',
      showSearchOptions: isEmpty,
      searchOptions: isEmpty ? buildSearchOptions(keyword) : []
    });
  },

  goBack() {
    wx.navigateBack({ delta: 1, fail: () => wx.redirectTo({ url: '/pages/index/index' }) });
  },

  onShareAppMessage() {
    return { title: '避坑导购 · 先看真实口碑再下单', path: '/pages/index/index' };
  }
});
