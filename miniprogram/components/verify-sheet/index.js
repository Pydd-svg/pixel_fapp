Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    visible: { type: Boolean, value: false },
    data: { type: Object, value: null },
    state: { type: String, value: 'done' }   // done | loading | empty | degraded
  },
  data: { summary: {}, sources: [], feedback: [] },
  observers: {
    'data, state': function (data) {
      const d = data || null;
      const summary = (d && d.search_summary) || {};
      const sources = (d && Array.isArray(d.sources) ? d.sources : [])
        .map((s) => (s && (s.site_name || s.name)) || '')
        .filter(Boolean);
      this.setData({
        summary,
        feedback: Array.isArray(summary.community_feedback) ? summary.community_feedback : [],
        sources
      });
    }
  },
  methods: {
    onClose() { this.triggerEvent('close', {}); },
    noop() {}
  }
});
