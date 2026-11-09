Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    text: { type: String, value: '' },
    speed: { type: Number, value: 35 },
    autoplay: { type: Boolean, value: true }
  },
  data: { displayed: '' },
  observers: {
    'text, autoplay': function () { this.play(); }
  },
  lifetimes: {
    attached() { this.play(); },
    detached() { this.stop(); }
  },
  methods: {
    stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } },
    play() {
      this.stop();
      const full = this.properties.text || '';
      if (!this.properties.autoplay || !full) {
        this.setData({ displayed: full });
        this.triggerEvent('done', {});
        return;
      }
      let i = 0;
      this.setData({ displayed: '' });
      this._timer = setInterval(() => {
        i += 1;
        this.setData({ displayed: full.slice(0, i) });
        if (i >= full.length) { this.stop(); this.triggerEvent('done', {}); }
      }, Math.max(10, this.properties.speed));
    },
    skip() { this.stop(); this.setData({ displayed: this.properties.text || '' }); this.triggerEvent('done', {}); }
  }
});
