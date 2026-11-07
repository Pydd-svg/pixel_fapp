/**
 * components/decision-card —— 决策卡（契约 §5.3）
 * 归属：A 出骨架与逻辑，C 精修 wxml/wxss。
 * 铁律：C 可以改结构、加 class、改文案，但**不得改 {{}} 绑定字段名，不得改 bind: 事件名**。
 */
Component({
  // 允许使用 app.wxss 里的 .sk（骨架动画）与 .tap（最小点击区）
  options: { addGlobalClass: true },

  properties: {
    // 传的是 decision_data，不是整包 DecisionCard
    card: { type: Object, value: null },
    // done | degraded | empty | loading
    state: { type: String, value: 'done' },
    // 是否显示依据条目（答辩演示时打开）
    showRefs: { type: Boolean, value: true }
  },

  data: {
    recs: [],
    flags: [],
    refs: [],
    confText: '',
    isLow: false,
    hasTags: false,
    shelf: '' // 展示用：置信度 + 是否降级
  },

  observers: {
    'card, state': function (card, state) {
      const c = card || {};
      const conf = c.confidence || '';
      const map = { high: '高', medium: '中', low: '低' };
      const tags = Array.isArray(c.tags) ? c.tags : [];
      this.setData({
        recs: Array.isArray(c.recommendations) ? c.recommendations : [],
        flags: Array.isArray(c.red_flags) ? c.red_flags : [],
        refs: Array.isArray(c.knowledge_refs) ? c.knowledge_refs : [],
        hasTags: tags.length > 0,
        confText: map[conf] || '',
        isLow: conf === 'low',
        shelf: state === 'degraded' ? '降级' : ''
      });
    }
  },

  methods: {
    // bind:copykeyword  detail: { keyword }
    onCopy() {
      const c = this.data.card || {};
      this.triggerEvent('copykeyword', { keyword: c.search_keyword || '' });
    },
    // bind:verify  detail: {}
    onVerify() {
      this.triggerEvent('verify', {});
    },
    // bind:save  detail: {}
    onSave() {
      this.triggerEvent('save', {});
    },
    // bind:share  detail: {}
    // 说明：真正的转发由页面 button open-type="share" 触发，这里只做埋点与兜底
    onShare() {
      this.triggerEvent('share', {});
    },
    // bind:report  detail: { reason: 'wrong' | 'outdated' }
    onReport(e) {
      const reason = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.reason) || 'wrong';
      this.triggerEvent('report', { reason });
    }
  }
});
