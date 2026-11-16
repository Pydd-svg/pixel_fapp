const aiClient = require('../../services/aiClient');
const storage = require('../../services/storage');

const QUICK_TEXT = {
  买电脑: '想买台笔记本电脑，预算还没想好，主要用来写论文',
  买手办: '想买个初音未来手办，预算 300 以内',
  买耳机: '想买个蓝牙耳机，预算 100 左右',
  买面霜: '想买一瓶面霜，敏感肌',
  宿舍用品: '想买宿舍床品，四件套'
};

// 使用前必读三条：文案在这里，样式在 components/read-gate
const READ_ITEMS = [
  { tag: '坑', title: '先看红线，再谈推荐', desc: '每张卡至少 1 条避坑红线，宁可少推荐也不让你买错' },
  { tag: '据', title: '每条建议都能点开', desc: '依据来自知识库原文，不编型号、不编价格、不编口碑' },
  { tag: '词', title: '只给关键词，不给链接', desc: '不替你下单，拿关键词去平台自己核对最稳' }
];

Page({
  data: {
    rawInput: '',
    loading: false,
    loadingSec: 0,
    // 流式预览：标题与红线随模型输出逐步出现，不用干等整张卡
    liveTitle: '',
    liveFlags: [],
    demoMode: false,
    archiveCount: 0,
    quickTags: Object.keys(QUICK_TEXT),
    readItems: READ_ITEMS,
    // 必读卡消融完，连下方留白一起收掉（纯布局，不构成操作门槛）
    gateGone: false,
    followupVisible: false,
    bubbles: [],
    showStateView: false,
    stateViewState: 'degraded',
    stateViewTitle: '',
    stateViewDesc: ''
  },

  onLoad() {
    this._history = [];
    this._busy = false;
    this._lastInput = '';
    this._offStage = aiClient.onStageChange((stage, payload) => this.onStage(stage, payload));
    const demo = aiClient.isDemoMode();
    this.setData({
      // 必读卡每次进入都重新走一遍（不记忆）；演示模式下组件自己 skip 并立刻回调 done
      gateGone: false,
      demoMode: demo,
      archiveCount: storage.listCards().length
    });
  },

  onShow() {
    this.setData({ demoMode: aiClient.isDemoMode(), archiveCount: storage.listCards().length });
    // 每次进入第 1 步都重新计时一遍（首次进入由组件 attached 自己启动）
    if (this._shownOnce) {
      this.setData({ gateGone: false });
      const gate = this.selectComponent('#rg');
      if (gate && gate.restart) gate.restart();
    }
    this._shownOnce = true;
  },

  onUnload() {
    this.stopClock();
    if (this._offStage) this._offStage();
  },

  onStage(stage, payload) {
    if (stage === 'partial' && payload) {
      const title = payload.title || '';
      const flags = payload.redFlags || [];
      if (title === this.data.liveTitle && flags.length === this.data.liveFlags.length) return;
      this.setData({ liveTitle: title, liveFlags: flags });
      return;
    }
    if (stage === 'degraded') {
      this.setData({
        showStateView: true,
        stateViewState: 'degraded',
        stateViewTitle: 'AI 开小差了',
        stateViewDesc: '网络或额度暂时不可用，稍后重试'
      });
    }
  },

  onGateDone() {
    // 卡片只是展示：读完就不占位，但从不阻塞输入和生成
    this.setData({ gateGone: true });
  },

  onInput(e) {
    this.setData({ rawInput: String(e.detail.value || '').slice(0, 200) });
  },

  onQuickTag(e) {
    const label = (e.currentTarget.dataset || {}).text || '';
    this.setData({ rawInput: QUICK_TEXT[label] || label });
  },

  async onSubmit() {
    if (this._busy) return;
    const rawInput = String(this.data.rawInput || '').trim();
    if (!rawInput) {
      wx.showToast({ title: '先说说你想买什么', icon: 'none' });
      return;
    }
    this._busy = true;
    this._lastInput = rawInput;

    const userBubble = { role: 'user', content: rawInput, ts: Date.now() };
    const bubbles = this.data.bubbles.concat(userBubble);
    this.setData({ loading: true, rawInput: '', bubbles, showStateView: false, liveTitle: '', liveFlags: [] });
    this.startClock();

    let card = null;
    let errCode = 'E_UNKNOWN';
    try {
      card = await aiClient.decide({
        rawInput,
        history: this._history.slice(-12),
        sessionId: (getApp().globalData || {}).sessionId || ''
      });
    } catch (e) {
      card = null;
      errCode = (e && e.code) || 'E_UNKNOWN';
    }

    this._busy = false;
    this.stopClock();

    if (!card) {
      this.setData({
        loading: false,
        showStateView: true,
        stateViewState: 'degraded',
        stateViewTitle: '生成失败',
        stateViewDesc: '请检查网络后重试（' + errCode + '）'
      });
      return;
    }

    // 信息不够：留在本页继续追问
    if (card.is_followup) {
      this._history.push({ role: 'user', content: rawInput });
      this._history.push({ role: 'assistant', content: card.followup_question || '' });
      this.setData({
        loading: false,
        followupVisible: true,
        bubbles: bubbles.concat({ role: 'assistant', content: card.followup_question || '', ts: Date.now() })
      });
      return;
    }

    this._history.push({ role: 'user', content: rawInput });

    if (card.status === 'error' || !card.decision_data) {
      this.setData({
        loading: false,
        showStateView: true,
        stateViewState: 'degraded',
        stateViewTitle: '这次没生成出来',
        stateViewDesc: (card.error_code || 'E_UNKNOWN') + '，点重试再试一次'
      });
      return;
    }

    this.setData({ loading: false, followupVisible: false, bubbles: [], showStateView: false });
    this._history = [];

    wx.navigateTo({
      url: '/pages/result/result',
      success: (res) => {
        res.eventChannel.emit('card', card);
        res.eventChannel.emit('context', { rawInput });
      }
    });
  },

  onRetry() {
    const input = this._lastInput;
    this._busy = false;
    this.stopClock();
    this.setData({ showStateView: false, loading: false, rawInput: input }, () => {
      if (input) this.onSubmit();
    });
  },

  // 出卡计时：把「到底等了多久」显示出来，用户能判断是卡死还是慢
  startClock() {
    this.stopClock();
    const t0 = Date.now();
    this.setData({ loadingSec: 0 });
    this._clock = setInterval(() => {
      this.setData({ loadingSec: Math.floor((Date.now() - t0) / 1000) });
    }, 1000);
  },

  stopClock() {
    if (this._clock) {
      clearInterval(this._clock);
      this._clock = null;
    }
  },

  onTypeWriterDone() {},

  goArchive() {
    wx.navigateTo({ url: '/pages/archive/archive' });
  },

  goVerify() {
    wx.navigateTo({ url: '/pages/verify/verify' });
  },

  goHome() {
    wx.redirectTo({ url: '/pages/index/index' });
  },

  onShareAppMessage() {
    return { title: '避坑导购 · 下单前先看红线', path: '/pages/index/index' };
  }
});
