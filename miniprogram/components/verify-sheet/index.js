/**
 * components/verify-sheet —— 查证半屏弹窗（契约 §5.4）
 * 归属：A 出逻辑，C 出样式。
 * properties: visible / data(VerifyResult) / state(loading|done|empty|degraded|error)
 * events: bind:close
 */
Component({
  // 复用 app.wxss 的 .tap（最小点击区）
  options: { addGlobalClass: true },

  properties: {
    visible: { type: Boolean, value: false },
    data: { type: Object, value: null },
    state: { type: String, value: 'loading' }
  },

  data: {
    feedback: [],
    sources: [],
    verdict: '',
    caution: ''
  },

  observers: {
    'data, state': function (data, state) {
      const d = data || {};
      const sum = d.search_summary || {};
      this.setData({
        verdict: sum.recent_verdict || '',
        feedback: Array.isArray(sum.community_feedback) ? sum.community_feedback : [],
        caution: sum.caution_alert || '',
        sources: Array.isArray(sum.sources_hint) ? sum.sources_hint : []
      });
    }
  },

  methods: {
    onClose() {
      this.triggerEvent('close', {});
    },
    // 阻止蒙层滚动穿透
    noop() {}
  }
});
