const aiClient = require('../../services/aiClient');
const storage = require('../../services/storage');

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

function greetingByHour(h) {
  if (h < 6) return '凌晨好';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

function buildWeek(today) {
  // 以周一为起点，展示本周 7 天
  const day = today.getDay() || 7;
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
    todayLabel: now.getMonth() + 1 + '月' + now.getDate() + '日 · 周' + WEEK_LABELS[(now.getDay() || 7) - 1],
    greeting: greetingByHour(now.getHours()),
    weekDays: buildWeek(now)
  };
}

Page({
  data: {
    demoMode: false,
    hasArchive: false,
    archiveCount: 0,
    todayLabel: '',
    greeting: '你好',
    weekDays: []
  },

  onLoad() {
    this._logoTaps = [];
    this.refreshHome();
  },

  onShow() {
    this.refreshHome();
    this.setData({ demoMode: aiClient.isDemoMode() });
  },

  refreshHome() {
    const count = storage.listCards().length;
    this.setData(Object.assign({ archiveCount: count, hasArchive: count > 0 }, buildHomeMeta()));
  },

  goAsk() {
    wx.navigateTo({ url: '/pages/ask/ask' });
  },

  goChat() {
    wx.navigateTo({ url: '/pages/chat/chat' });
  },

  goVerify() {
    wx.navigateTo({ url: '/pages/verify/verify' });
  },

  goArchive() {
    wx.navigateTo({ url: '/pages/archive/archive' });
  },

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

  onShareAppMessage() {
    return { title: '避坑导购 · 下单前先看红线', path: '/pages/index/index' };
  }
});
