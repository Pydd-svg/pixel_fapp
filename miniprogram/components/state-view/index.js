const DEFAULT_TEXT = {
  loading: { title: '正在翻避坑库', desc: '马上就好，不会让你一直等' },
  empty: { title: '还没有保存过决策卡', desc: '去问一句，先拿一张卡' },
  degraded: { title: 'AI 开小差了', desc: '网络或额度暂时不可用，稍后重试' },
  demo: { title: '演示模式', desc: '数据为预置样例，非实时结果' }
};

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    state: { type: String, value: 'loading' },   // loading | empty | degraded | demo
    title: { type: String, value: '' },
    desc: { type: String, value: '' },
    // 按钮文案由调用方决定：empty 态不该写「重试」（这里没有可重试的动作）
    actionText: { type: String, value: '重试' }
  },
  data: { viewTitle: '', viewDesc: '' },
  observers: {
    'state, title, desc': function (state, title, desc) {
      const base = DEFAULT_TEXT[state] || DEFAULT_TEXT.loading;
      this.setData({ viewTitle: title || base.title, viewDesc: desc || base.desc });
    }
  },
  methods: {
    onRetry() { this.triggerEvent('retry', {}); }
  }
});
