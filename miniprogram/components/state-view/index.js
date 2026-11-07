/**
 * components/state-view —— 四态统一容器（契约 §5.4）
 * 归属：A 出逻辑，C 出样式。
 * 走查表第 7 条：loading / empty / degraded / demo 都必须有设计，不能只做成功态。
 */
Component({
  // 复用 app.wxss 的 .tap（最小点击区）
  options: { addGlobalClass: true },

  properties: {
    // loading | empty | degraded | demo
    state: { type: String, value: 'empty' },
    title: { type: String, value: '' },
    desc: { type: String, value: '' }
  },

  data: {
    defaultTitle: '',
    defaultDesc: ''
  },

  observers: {
    state: function (s) {
      this.applyDefaults(s);
    }
  },

  lifetimes: {
    attached: function () {
      // 初次挂载时 state 若没变化不会触发 observer，这里补一次
      this.applyDefaults(this.data.state);
    }
  },

  methods: {
    applyDefaults(s) {
      const tips = {
        loading: ['正在翻避坑库', '一般 8 秒内出卡，超过 12 秒会自动降级'],
        empty: ['这里还没有东西', '先去首页描述一下你想买什么'],
        degraded: ['AI 开小差了', '先看看下面的通用建议，或者点重试'],
        demo: ['演示模式', '当前是本地预置回放，不会发起网络请求']
      };
      const t = tips[s] || tips.empty;
      this.setData({ defaultTitle: t[0], defaultDesc: t[1] });
    },

    onRetry() {
      this.triggerEvent('retry', {});
    }
  }
});
