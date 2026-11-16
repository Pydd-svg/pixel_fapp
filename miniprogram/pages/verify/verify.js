const aiClient = require('../../services/aiClient');

function normalizeSources(list) {
  return (Array.isArray(list) ? list : [])
    .map((s) => (s && (s.site_name || s.name)) || '')
    .filter(Boolean);
}

Page({
  data: {
    keyword: '',
    loading: false,
    state: 'idle', // idle | loading | done | empty | degraded
    verdict: '',
    feedback: [],
    caution: '',
    sources: [],
    errorCode: ''
  },

  onLoad(query) {
    const kw = query && query.kw ? decodeURIComponent(query.kw) : '';
    if (kw) this.setData({ keyword: String(kw).slice(0, 30) });
  },

  onInput(e) {
    this.setData({ keyword: String(e.detail.value || '').slice(0, 30) });
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
      state: 'loading',
      verdict: '',
      feedback: [],
      caution: '',
      sources: [],
      errorCode: ''
    });

    let res = null;
    try {
      res = await aiClient.verify({ searchKeyword: keyword, cardTitle: '' });
    } catch (e) {
      res = { status: 'degraded', error_code: (e && e.code) || 'E_UNKNOWN', search_summary: {} };
    }

    const summary = (res && res.search_summary) || {};
    const status = (res && res.status) || 'degraded';

    if (status === 'success') {
      this.setData({
        loading: false,
        state: 'done',
        verdict: summary.recent_verdict || '暂时只拿到零散说法，建议再看一眼基础决策',
        feedback: Array.isArray(summary.community_feedback) ? summary.community_feedback : [],
        caution: summary.caution_alert || '',
        sources: normalizeSources(res.sources)
      });
      return;
    }

    this.setData({
      loading: false,
      state: status === 'empty' ? 'empty' : 'degraded',
      errorCode: (res && res.error_code) || ''
    });
  },

  goBack() {
    wx.navigateBack({ delta: 1, fail: () => wx.redirectTo({ url: '/pages/index/index' }) });
  },

  onShareAppMessage() {
    return { title: '避坑导购 · 先看真实口碑再下单', path: '/pages/index/index' };
  }
});
