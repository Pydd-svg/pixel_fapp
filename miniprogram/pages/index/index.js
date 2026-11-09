const aiClient = require('../../services/aiClient');
const storage = require('../../services/storage');

const QUICK_TEXT = {
  买电脑: '想买台笔记本电脑，预算还没想好，主要用来写论文',
  买手办: '想买个初音未来手办，预算 300 以内',
  买耳机: '想买个蓝牙耳机，预算 100 左右',
  买面霜: '想买一瓶面霜，敏感肌',
  宿舍用品: '想买宿舍床品，四件套'
};

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

function greetingByHour(h) {
  if (h < 6) return '凌晨好';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

function buildWeek(today) {
  // 以周一为起点，展示本周 7 天
  const day = today.getDay() || 7; // 周日 = 7
  const monday = new Date(today.getTime() - (day - 1) * 86400000);
  return WEEK_LABELS.map((label, i) => {
    const d = new Date(monday.getTime() + i * 86400000);
    return {
      label,
      date: d.getDate(),
      isToday: d.getDate() === today.getDate() && d.getMonth() === today.getMonth()
    };
  });
}

function buildHomeMeta() {
  const now = new Date();
  return {
    todayLabel: now.getMonth() + 1 + '月' + now.getDate() + '日 · 周' + (WEEK_LABELS[(now.getDay() || 7) - 1]),
    greeting: greetingByHour(now.getHours()),
    weekDays: buildWeek(now)
  };
}

Page({
  data: {
    rawInput: '',
    loading: false,
    demoMode: false,
    hasArchive: false,
    archiveCount: 0,
    todayLabel: '',
    greeting: '你好',
    weekDays: [],
    quickTags: Object.keys(QUICK_TEXT),
    quickReplies: ['预算 500 以内', '预算 1000 左右', '没想好，你建议'],
    followupVisible: false,
    bubbles: [],
    showStateView: false,
    stateViewState: 'degraded',
    stateViewTitle: '',
    stateViewDesc: ''
  },

  onLoad() {
    this._history = [];
    this._logoTaps = [];
    this._busy = false;
    this._lastInput = '';
    this._offStage = aiClient.onStageChange((stage, payload) => this.onStage(stage, payload));
    this.refreshHome();
  },

  onShow() {
    this.refreshHome();
    this.setData({ demoMode: aiClient.isDemoMode() });
  },

  onUnload() {
    if (this._offStage) this._offStage();
  },

  refreshHome() {
    const count = storage.listCards().length;
    this.setData(Object.assign({ archiveCount: count, hasArchive: count > 0 }, buildHomeMeta()));
  },

  onStage(stage) {
    if (stage === 'degraded') {
      this.setData({
        showStateView: true,
        stateViewState: 'degraded',
        stateViewTitle: 'AI 开小差了',
        stateViewDesc: '网络或额度暂时不可用，稍后重试'
      });
    }
  },

  onInput(e) {
    this.setData({ rawInput: String(e.detail.value || '').slice(0, 200) });
  },

  onQuickTag(e) {
    const label = (e.currentTarget.dataset || {}).text || '';
    this.setData({ rawInput: QUICK_TEXT[label] || label });
  },

  onQuickReply(e) {
    const text = (e.currentTarget.dataset || {}).text || '';
    this.setData({ rawInput: text }, () => this.onSubmit());
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
    this.setData({
      loading: true,
      rawInput: '',
      bubbles,
      showStateView: false
    });

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

    if (!card) {
      this.setData({ loading: false, showStateView: true, stateViewState: 'degraded', stateViewTitle: '生成失败', stateViewDesc: '请检查网络后重试（' + errCode + '）' });
      return;
    }

    // 追问：留在首页继续补信息
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
    this.setData({ showStateView: false, loading: false, rawInput: input }, () => {
      if (input) this.onSubmit();
    });
  },

  onTypeWriterDone() {},

  onLogoTap() {
    const now = Date.now();
    this._logoTaps = (this._logoTaps || []).filter((t) => now - t < 2000);
    this._logoTaps.push(now);
    if (this._logoTaps.length >= 5) {
      this._logoTaps = [];
      const on = aiClient.setDemoMode(!aiClient.isDemoMode());
      this.setData({ demoMode: aiClient.isDemoMode() });
      wx.showToast({ title: on ? '演示模式已开启' : '演示模式已关闭', icon: 'none' });
    }
  },

  onVersionLongPress() {
    wx.navigateTo({ url: '/pages/dev/dev' });
  },

  goArchive() {
    wx.navigateTo({ url: '/pages/archive/archive' });
  },

  onShareAppMessage() {
    return {
      title: '避坑导购 · 下单前先看红线',
      path: '/pages/index/index'
    };
  }
});
