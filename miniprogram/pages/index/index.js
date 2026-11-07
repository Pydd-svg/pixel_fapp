/**
 * pages/index —— 首页：输入 + 快捷标签 + 追问打字机（契约 P2-2.7）
 * 归属：A 写 js/json，C 精修 wxml/wxss。
 * 页面跳转约定：出卡后走 eventChannel 传对象，**不用全局变量**（真机偶发丢引用）。
 */
const aiClient = require('../../services/aiClient');
const storage = require('../../services/storage');
const metrics = require('../../services/metrics');
const config = require('../../services/config');
const C = require('../../services/constants');

const QUICK_TAGS = ['想买台笔记本电脑', '初音手办 300以内', '100元内蓝牙耳机', '学妹让我挑面霜'];
const MAX_HISTORY = 12; // 6 轮

Page({
  data: {
    rawInput: '',
    stage: 'idle',
    loading: false,
    followup: '',
    followupReady: false,
    history: [],
    quickTags: QUICK_TAGS,
    demoMode: false,
    usageText: '',
    tip: '',
    version: config.APP_VERSION
  },

  onLoad() {
    // 阶段订阅：C 用它驱动骨架屏/打字机；这里只落自己的状态
    this._off = aiClient.onStageChange((stage) => {
      if (this.data.loading && stage !== this.data.stage) this.setData({ stage });
    });
    this.setData({ demoMode: aiClient.isDemoMode() });
    this.refreshUsage();
  },

  onShow() {
    this.setData({ demoMode: aiClient.isDemoMode() });
    this.refreshUsage();
  },

  onUnload() {
    if (this._off) this._off();
  },

  refreshUsage() {
    if (config.FEATURE.quota === false) {
      this.setData({ usageText: '今日不限次数' });
      return;
    }
    const q = storage.checkQuota('decide', config.LIMIT);
    this.setData({ usageText: '今日还剩 ' + Math.max(0, q.cap - q.used) + ' 次决策' });
  },

  onInput(e) {
    this.setData({ rawInput: (e.detail && e.detail.value) || '' });
  },

  onQuickTag(e) {
    const tag = (e.currentTarget.dataset && e.currentTarget.dataset.tag) || '';
    if (!tag || this.data.loading) return;
    this.setData({ rawInput: tag }, () => this.submit());
  },

  onSubmit() {
    this.submit();
  },

  /** 核心流转：输入 → 追问 → 补充 → 出卡 */
  async submit() {
    if (this.data.loading) return;
    const input = String(this.data.rawInput || '').trim();
    if (!input) {
      wx.showToast({ title: '先说想买什么', icon: 'none' });
      return;
    }

    this.setData({ loading: true, stage: 'judging', tip: '' });
    const app = getApp();
    const history = this.data.history;

    let card;
    try {
      card = await aiClient.decide({
        rawInput: input,
        history,
        sessionId: (app && app.globalData && app.globalData.sessionId) || ''
      });
    } catch (e) {
      // decide 契约上永不 reject；这里只兜极端情况（例如页面被销毁）
      this.setData({ loading: false, stage: 'degraded', tip: '这次没连上，再点一次试试' });
      return;
    }

    const nextHistory = history.concat([{ role: 'user', content: input }]).slice(-MAX_HISTORY);

    if (card.is_followup) {
      // 演示模式：把回放的标准答案放进快捷标签，点一下就能出卡
      const tags = this._sampleAnswer ? [this._sampleAnswer] : QUICK_TAGS;
      this.setData({
        history: nextHistory.concat([{ role: 'assistant', content: card.followup_question }]).slice(-MAX_HISTORY),
        followup: card.followup_question,
        followupReady: false,
        loading: false,
        stage: 'idle',
        rawInput: '',
        quickTags: tags,
        tip: card.status === 'degraded' ? '这条追问是本地兜底，AI 这次不太顺' : ''
      });
      this.refreshUsage();
      return;
    }

    this.setData({ loading: false, stage: 'done', history: nextHistory, followup: '', rawInput: '', quickTags: QUICK_TAGS });
    this.refreshUsage();

    if (card.status === 'degraded') {
      const msg = C.ERROR_TEXT[card.error_code] || 'AI 开小差了，先给通用建议';
      if (card.error_code === 'E_QUOTA') {
        // 超额不堵死用户：给一条去档案页的路（契约 P3-3.3）
        wx.showModal({
          title: '今日次数已用完',
          content: msg + '。历史卡片都在「我的档案」里，不消耗次数。',
          confirmText: '看档案',
          cancelText: '知道了',
          success: (r) => {
            if (r.confirm) wx.navigateTo({ url: '/pages/archive/archive' });
          }
        });
      } else {
        wx.showToast({ title: msg, icon: 'none', duration: 1800 });
      }
    }

    wx.navigateTo({
      url: '/pages/result/result',
      success: (res) => {
        // 契约 §5.3：事件名 card，载荷是整包 DecisionCard
        res.eventChannel.emit('card', card);
        res.eventChannel.emit('context', { rawInput: input });
      }
    });
  },

  onFollowupDone() {
    this.setData({ followupReady: true });
  },

  /** 连点 LOGO 5 次（1.5s 内）切 Demo 模式（契约 P5-5.6） */
  onLogoTap() {
    const now = Date.now();
    this._taps = (this._taps || []).filter((t) => now - t < 1500);
    this._taps.push(now);
    if (this._taps.length < 5) return;

    this._taps = [];
    const next = !aiClient.isDemoMode();
    aiClient.setDemoMode(next);
    this.setData({ demoMode: next, quickTags: QUICK_TAGS });
    wx.showToast({ title: next ? '已进入演示模式（本地回放）' : '已退出演示模式', icon: 'none', duration: 1800 });
  },

  /**
   * 验收入口：一键进演示模式并跑完第一轮（A 加）
   * 不配置云环境也能看到完整卡片；追问出现后把标准答案放进快捷标签，
   * 用户再点一下就走完「追问 → 出卡」闭环。
   */
  onSampleTap() {
    if (this.data.loading) return;
    const replays = (require('../../demo/replay') || {}).replays || [];
    const r = replays[0];
    if (!r) {
      wx.showToast({ title: '演示数据未生成，先跑 npm run assets', icon: 'none' });
      return;
    }
    aiClient.setDemoMode(true);
    this._sampleAnswer = (r.followup && r.followup.answer) || '';
    this.setData({ demoMode: true, quickTags: QUICK_TAGS, rawInput: r.input }, () => this.submit());
  },

  onSampleExit() {
    aiClient.setDemoMode(false);
    this._sampleAnswer = '';
    this.setData({ demoMode: false, quickTags: QUICK_TAGS, followup: '', rawInput: '', tip: '' });
  },

  goArchive() {
    wx.navigateTo({ url: '/pages/archive/archive' });
  },

  /** 长按版本号进自检页（不上线导航，避免评委误入） */
  onVersionLongPress() {
    metrics.record({ action: 'open_dev' });
    wx.navigateTo({ url: '/pages/dev/dev' });
  }
});
