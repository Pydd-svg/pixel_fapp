/**
 * components/type-writer —— 打字机（契约 §5.4）
 * 归属：A 出逻辑，C 出样式。
 * 为什么是「伪流式」：非流式拿完整 JSON，前端做打字动画。
 * 真流式增量解析结构化 JSON 的失败率在 12 天工期下不可接受（v2 §4.3-①）。
 */
Component({
  properties: {
    text: { type: String, value: '' },
    speed: { type: Number, value: 35 },
    autoplay: { type: Boolean, value: true }
  },

  data: {
    shown: '',
    finished: false
  },

  observers: {
    text: function (v) {
      this.play(v);
    }
  },

  lifetimes: {
    detached: function () {
      this.stop();
    }
  },

  methods: {
    play(value) {
      this.stop();
      const chars = Array.from(String(value || ''));
      if (!chars.length) {
        this.setData({ shown: '', finished: true });
        return;
      }
      if (!this.data.autoplay) {
        this.setData({ shown: chars.join(''), finished: true });
        this.triggerEvent('done', {});
        return;
      }

      let i = 0;
      const speed = Math.max(10, Number(this.data.speed) || 35);
      this.setData({ shown: '', finished: false });
      this._timer = setInterval(() => {
        i += 1;
        this.setData({ shown: chars.slice(0, i).join('') });
        if (i >= chars.length) {
          this.stop();
          this.setData({ finished: true });
          this.triggerEvent('done', {});
        }
      }, speed);
    },

    stop() {
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
    },

    /** 点一下直接显示全文（长文案时给用户逃生口） */
    skip() {
      this.stop();
      this.setData({ shown: String(this.data.text || ''), finished: true });
      this.triggerEvent('done', {});
    }
  }
});
