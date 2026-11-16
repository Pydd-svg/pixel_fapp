/**
 * read-gate —— 使用前必读（白卡 + 内存释放式消融）
 *
 * 视觉：白卡，右上角一块近黑小方块显示 `12s`（两位定宽 + 等宽字体 + 磷光绿），
 *       数字右边跟一个 Hacknet 终端光标（实心方块，硬切闪烁）。
 *       数字全程稳定：不闪、不覆写乱码、块宽不变。
 *       归零后停在 `00s`，紧接着整张卡从底部开始连续、平滑地化掉、直到高度为 0；
 *       底边是一条 64rpx 渐隐带，内容淡进页面底色，不留硬切口。
 * 交互：卡片只是展示，不构成「必须读完才能操作」的门槛——输入和生成随时可用。
 *       消融结束触发 bind:done（页面据此收掉留白）；轻点计时块可立刻结束等待。
 *       每次进入本页由页面调 restart() 重来一遍，不做"读过就永久不再出现"的记忆。
 */

// 消融时长：高度交给 CSS transition 连续收缩，不再一档一档跳
const DISSOLVE_MS = 900;

Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    seconds: { type: Number, value: 12 },
    // [{ tag:'坑', title:'先看红线，再谈推荐', desc:'…' }]
    items: { type: Array, value: [] },
    autoStart: { type: Boolean, value: true },
    // 演示模式下跳过计时，直接给「已解锁」态
    skip: { type: Boolean, value: false },
  },

  data: {
    sec: 12,
    // [{ i, ch, unit }]
    chars: [],
    done: false,
    // 正在消融：显示回收边
    dying: false,
    // 已消融完：整块高度归零，不再占位
    gone: false,
    // 内联高度（px），消融过程由这里逐档收紧
    stageStyle: '',
  },

  lifetimes: {
    attached() {
      this.build();
    },
    detached() {
      this.stopTimers();
    },
  },

  methods: {
    build() {
      const total = this.data.seconds || 12;
      this._total = total;
      this._fired = false;
      this._finished = false;

      // 演示模式：不占位、直接放行
      if (this.data.skip) {
        this.setData({ sec: 0, chars: [], done: true, gone: true, stageStyle: 'height:0px' }, () => {
          this.triggerEvent('done', {});
        });
        return;
      }

      this.setData({ sec: total, chars: this.render(total), done: false, gone: false, stageStyle: '' }, () => {
        if (this.data.autoStart) this.start();
      });
    },

    /** 重新走一遍（每次进入第 1 步时由页面调用） */
    restart() {
      // 演示模式不占位，但要把「已放行」重新告诉页面，否则按钮会一直禁着
      if (this.data.skip) {
        this.triggerEvent('done', {});
        return;
      }
      this.stopTimers();
      this._fired = false;
      this._finished = false;
      const total = this.data.seconds || 12;
      this._total = total;
      this.setData(
        { sec: total, chars: this.render(total), done: false, dying: false, gone: false, stageStyle: '' },
        () => this.start()
      );
    },

    /** 两位定宽的数字 + 单位 s：宽度恒定，整块不跳 */
    render(sec) {
      const n = Math.max(0, Math.floor(sec));
      const s = n < 10 ? '0' + n : String(n);
      const arr = [];
      for (let k = 0; k < s.length; k++) {
        arr.push({ i: arr.length, ch: s.charAt(k), unit: false });
      }
      arr.push({ i: arr.length, ch: 's', unit: true });
      return arr;
    },

    start() {
      this.stopTimers();
      this._startAt = Date.now();
      this._total = this.data.seconds || 12;
      this._fired = false;
      this._timer = setInterval(() => this.tick(), 200);
    },

    stopTimers() {
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
      if (this._stepTimer) {
        clearTimeout(this._stepTimer);
        this._stepTimer = null;
      }
      if (this._measureTimer) {
        clearTimeout(this._measureTimer);
        this._measureTimer = null;
      }
      if (this._timers && this._timers.length) {
        this._timers.forEach((t) => clearTimeout(t));
        this._timers = [];
      }
    },

    tick() {
      if (this.data.done) return;

      const total = this._total || this.data.seconds || 12;
      const elapsed = Math.min(total, (Date.now() - this._startAt) / 1000);
      const remain = total - elapsed;

      if (remain <= 0.001) {
        this.collapse();
        return;
      }

      const sec = Math.max(1, Math.ceil(remain));
      this.setData({ sec, chars: this.render(sec) });
    },

    /** 归零：量出整卡高度，交给平滑消融 */
    collapse() {
      if (this._fired) return;
      this._fired = true;
      this.stopTimers();

      this.createSelectorQuery()
        .select('.rg-stage')
        .boundingClientRect((rect) => {
          const h = Math.round((rect && rect.height) || 0);
          this.runDissolve(h > 60 ? h : 360);
        })
        .exec();

      // 兜底：量高回调万一没回来，也不能让卡片赖着不走
      this._measureTimer = setTimeout(() => {
        if (!this.data.dying) this.runDissolve(360);
      }, 400);
    },

    /**
     * 消融：stage 高度从整卡高度连续收到 0（CSS transition 驱动）。
     * 卡片本身尺寸不变，只是被父级 overflow:hidden 从下面裁掉，
     * 所以内容不会重排，看起来就是「底边往上化掉、上面的内容跟着落下来」。
     */
    runDissolve(h) {
      if (this._measureTimer) {
        clearTimeout(this._measureTimer);
        this._measureTimer = null;
      }
      if (this.data.dying) return;

      // 先把高度固定成整卡高度（同时挂上 transition 类）
      this.setData({ sec: 0, chars: this.render(0), dying: true, stageStyle: 'height:' + h + 'px' });

      // 留一帧让显式高度先生效，再收到 0 —— 两次高度若合并成一次，
      // 浏览器不会跑 transition，就又会变成"啪"地一下
      this._stepTimer = setTimeout(() => {
        this.setData({ stageStyle: 'height:0px' });
        this._stepTimer = setTimeout(() => this.finish(), DISSOLVE_MS + 100);
      }, 80);
    },

    finish() {
      if (this._finished) return;
      this._finished = true;
      this.stopTimers();
      this.setData({ stageStyle: 'height:0px', gone: true, done: true }, () => {
        this.triggerEvent('done', {});
      });
    },

    /** 轻点计时块：不强制读完，直接结束等待、开始消融 */
    onTimerTap() {
      if (this.data.done || this.data.dying) return;
      this.collapse();
    },

    onTimerLongPress() {
      if (this.data.done || this.data.dying) return;
      this.collapse();
    },
  },
});
