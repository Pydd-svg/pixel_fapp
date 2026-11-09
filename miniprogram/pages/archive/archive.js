/**
 * pages/archive —— 我的档案（本地，只存最近 20 条）
 * 归属：A 写 js/json，C 精修 wxml/wxss。
 * 隐私叙事：所有数据只在端上，云端不留原始输入（v2 §4.3-③）。
 */
const storage = require('../../services/storage');
const C = require('../../services/constants');

const CONF_LABEL = { high: '高置信', medium: '中置信', low: '低置信' };

function fmt(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

Page({
  data: {
    list: [],
    empty: true,
    count: 0,
    max: storage.MAX_CARDS
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const list = storage.listCards().map((x) => ({
      id: x.id,
      title: x.title,
      category: x.category,
      categoryLabel: C.CATEGORY_LABEL[x.category] || x.category || '通用',
      confidence: x.confidence,
      confidenceLabel: CONF_LABEL[x.confidence] || '未标注',
      status: x.status,
      tsText: fmt(x.ts)
    }));
    this.setData({ list, empty: !list.length, count: list.length });
  },

  onOpen(e) {
    const id = e.currentTarget.dataset.id;
    const rec = storage.getCard(id);
    if (!rec || !rec.card) {
      wx.showToast({ title: '这条记录已损坏', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: '/pages/result/result?from=archive',
      success: (res) => {
        res.eventChannel.emit('card', rec.card);
        res.eventChannel.emit('context', { rawInput: rec.raw_input || '' });
      }
    });
  },

  onDelete(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删掉这张卡？',
      content: '只删本地记录，不影响其他卡片',
      success: (r) => {
        if (!r.confirm) return;
        storage.removeCard(id);
        this.refresh();
      }
    });
  },

  onClear() {
    if (this.data.empty) return;
    wx.showModal({
      title: '清空全部档案？',
      content: '共 ' + this.data.count + ' 张，清空后不可恢复',
      success: (r) => {
        if (!r.confirm) return;
        storage.clearCards();
        this.refresh();
      }
    });
  },

  goHome() {
    wx.redirectTo({ url: '/pages/index/index' });
  }
});
