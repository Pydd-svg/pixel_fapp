const KB = require('../../services/knowledge');
const C = require('../../services/constants');

const CONF_LABEL = { high: '高置信', medium: '中置信', low: '低置信' };
const FALLBACK_FLAGS = [
  '下单前录一遍开箱视频，留证据',
  '低于官方六折的全新现货先怀疑',
  '二手一定要求卖家拍特写视频'
];

Component({
  options: { styleIsolation: 'apply-shared' },
  externalClasses: ['ext-class'],
  properties: {
    card: { type: Object, value: null },       // 契约 §5.3：传 decision_data，不是整包
    state: { type: String, value: 'done' },    // done | degraded | empty | loading
    showRefs: { type: Boolean, value: true },
    errorCode: { type: String, value: '' },    // 降级时展示，方便定位原因
    errorText: { type: String, value: '' },
    errorDetail: { type: String, value: '' }
  },
  data: {
    confidenceLabel: '',
    confidenceClass: '',
    entityUnknown: false,
    entityText: '',
    categoryLabel: '',
    priceNote: '',
    refsList: [],
    fallbackFlags: FALLBACK_FLAGS,
    expanded: {}
  },
  observers: {
    'card, state': function (card, state) {
      const d = card || null;
      const entityUnknown = !!d && d.entity_status === 'unknown';
      const entities = d && Array.isArray(d.unverified_entities) ? d.unverified_entities : [];
      this.setData({
        confidenceLabel: d ? (entityUnknown ? '仅品类通用建议' : (CONF_LABEL[d.confidence] || '')) : '',
        confidenceClass: d ? (entityUnknown ? 'conf-low' : ('conf-' + d.confidence)) : '',
        entityUnknown,
        entityText: entities.length ? entities.slice(0, 2).join('、') : '该商品',
        categoryLabel: d ? (C.CATEGORY_LABEL[d.category] || '该类') : '该类',
        priceNote: d ? (d.price_note || '') : '',
        refsList: d && Array.isArray(d.knowledge_refs) ? d.knowledge_refs : []
      });
      if (state !== 'done') this.setData({ expanded: {} });
    }
  },
  methods: {
    keyword() {
      const d = this.properties.card;
      return d ? d.search_keyword : '';
    },
    onCopyKeyword() { this.triggerEvent('copykeyword', { keyword: this.keyword() }); },
    onVerify() { this.triggerEvent('verify', {}); },
    onSave() { this.triggerEvent('save', {}); },
    onShare() { this.triggerEvent('share', {}); },
    onReport() {
      wx.showActionSheet({
        itemList: ['信息有误', '内容过时'],
        success: (res) => this.triggerEvent('report', { reason: res.tapIndex === 0 ? 'wrong' : 'outdated' }),
        fail: () => {}
      });
    },
    // 依据可溯源：点 id 弹窗显示知识库原文
    onRefTap(event) {
      const id = event.currentTarget.dataset.id;
      const item = KB.getById(id);
      wx.showModal({
        title: item ? '[' + item.id + '] ' + item.title : id,
        content: item
          ? item.content + '\n\n严重度：' + item.severity + ' ｜ 更新：' + item.updated_at
          : '这条依据已不在当前知识库中',
        showCancel: false,
        confirmText: '知道了',
        confirmColor: '#3F6B12'
      });
    },
    onTogglePros(event) {
      const idx = event.currentTarget.dataset.idx;
      const expanded = Object.assign({}, this.data.expanded);
      expanded[idx] = !expanded[idx];
      this.setData({ expanded });
    },
    onRetry() { this.triggerEvent('retry', {}); }
  }
});
