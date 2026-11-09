/**
 * pages/result —— 决策卡结果页（契约 P2-2.8 / P4）
 * 归属：A 写 js/json，C 精修 wxml/wxss。
 * 接收：eventChannel 'card'（整包 DecisionCard）+ 'context'（{rawInput}）
 * 绑定：decision-card 的 5 个事件 + verify-sheet 的 close
 */
const aiClient = require('../../services/aiClient');
const storage = require('../../services/storage');
const metrics = require('../../services/metrics');
const C = require('../../services/constants');

Page({
  data: {
    card: null, // 传给组件的是 decision_data
    status: 'success',
    state: 'done', // done | degraded | empty | loading
    showRefs: true,
    rawInput: '',
    saved: false,
    verifying: false,
    verifyVisible: false,
    verifyData: null,
    verifyState: 'loading',
    errorText: '',
    errorCode: '',
    errorDetail: '',
    demoMode: false
  },

  onLoad(options) {
    this.fullCard = null;
    this.setData({ demoMode: aiClient.isDemoMode() });

    const ec = this.getOpenerEventChannel ? this.getOpenerEventChannel() : null;
    if (ec && typeof ec.on === 'function') {
      ec.on('card', (card) => this.applyCard(card));
      ec.on('context', (ctx) => {
        if (ctx && ctx.rawInput) this.setData({ rawInput: ctx.rawInput });
      });
    }

    // 冷启动兜底：直接进来（如分享链接）没有数据，给空态而不是白屏
    if (!this.fullCard && !(options && options.from)) {
      this.setData({ state: 'empty' });
    }
  },

  applyCard(card) {
    if (!card || typeof card !== 'object') {
      this.setData({ state: 'empty' });
      return;
    }
    this.fullCard = card;
    const dd = card.decision_data || null;
    const state = card.status === 'degraded' ? 'degraded' : dd ? 'done' : 'empty';
    this.setData({
      card: dd,
      status: card.status || 'success',
      state,
      errorText: card.error_code ? C.ERROR_TEXT[card.error_code] || '' : '',
      errorCode: card.error_code || '',
      errorDetail: ((card.meta && card.meta.error_message) || '').slice(0, 160)
    });
    if (dd && dd.card_title) wx.setNavigationBarTitle({ title: dd.card_title });
  },

  /* ------------------------- decision-card 事件 ------------------------- */

  // bind:copykeyword  detail:{keyword}
  onCopyKeyword(e) {
    const kw = (e && e.detail && e.detail.keyword) || (this.data.card && this.data.card.search_keyword) || '';
    if (!kw) {
      wx.showToast({ title: '这张卡没有搜索词', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: kw,
      success: () => {
        wx.showToast({ title: '搜索词已复制', icon: 'none' }); // 走查表第 12 条
        metrics.record({ action: 'copy' });
      }
    });
  },

  // bind:verify  detail:{}
  async onVerify() {
    const d = this.data.card;
    if (!d || this.data.verifying) return;

    this.setData({ verifyVisible: true, verifyState: 'loading', verifyData: null, verifying: true });
    const res = await aiClient.verify({ searchKeyword: d.search_keyword, cardTitle: d.card_title });
    const state = res.status === 'success' ? 'done' : res.status === 'empty' ? 'empty' : 'degraded';
    this.setData({ verifyData: res, verifyState: state, verifying: false });
  },

  onCloseVerify() {
    this.setData({ verifyVisible: false });
  },

  // bind:save  detail:{}
  onSave() {
    if (!this.fullCard) return;
    if (this.data.saved) {
      wx.showToast({ title: '已经在档案里了', icon: 'none' });
      return;
    }
    const r = storage.saveCard(this.fullCard, { rawInput: this.data.rawInput });
    if (r.ok) {
      this.setData({ saved: true });
      wx.showToast({ title: '已存到我的档案', icon: 'none' });
      metrics.record({ action: 'save' });
    } else {
      wx.showToast({ title: '存储失败，可能是空间不足', icon: 'none' });
    }
  },

  // bind:share  detail:{}（真正转发由 open-type="share" 触发）
  onShare() {
    metrics.record({ action: 'share' });
  },

  // bind:report  detail:{reason:'wrong'|'outdated'}
  onReport(e) {
    const reason = (e && e.detail && e.detail.reason) || 'wrong';
    metrics.record({ action: 'report', error_code: reason });
    wx.showToast({ title: '收到，会用来改进知识库', icon: 'none' });
  },

  /* ------------------------------ 其他 ------------------------------ */

  async onRetry() {
    const input = this.data.rawInput;
    if (!input) {
      wx.navigateBack({ delta: 1, fail: () => wx.redirectTo({ url: '/pages/index/index' }) });
      return;
    }
    this.setData({ state: 'loading' });
    const card = await aiClient.decide({ rawInput: input, history: [] });
    if (card.is_followup) {
      wx.navigateBack({ delta: 1, fail: () => wx.redirectTo({ url: '/pages/index/index' }) });
      return;
    }
    this.applyCard(card);
  },

  onStateRetry() {
    this.onRetry();
  },

  goHome() {
    wx.redirectTo({ url: '/pages/index/index' });
  },

  onShareAppMessage() {
    metrics.record({ action: 'share' });
    const d = this.data.card;
    return {
      title: (d && d.card_title) || '避坑导购 · 下单前 30 秒自查',
      path: '/pages/index/index'
      // C 补 5:4 封面后加 imageUrl: '/assets/images/share-cover.png'
    };
  }
});
