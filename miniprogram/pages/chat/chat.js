const chatClient = require('../../services/chatClient');

let messageId = 0;

function nextId(prefix) {
  messageId += 1;
  return prefix + '-' + Date.now() + '-' + messageId;
}

function errorText(err) {
  const code = err && err.code;
  if (code === 'E_CONTENT') return '这个内容暂时无法处理，请换个说法。';
  if (code === 'E_TIMEOUT') return '回答超时，请重试。';
  if (code === 'E_QUOTA') return '服务额度不足，请稍后再试。';
  return '暂时无法回答，请稍后重试。';
}

Page({
  data: {
    messages: [],
    input: '',
    sending: false,
    canSend: false,
    stage: 'thinking',
    scrollTop: 0
  },

  onLoad() {
    this._alive = true;
    this._scrollTick = 0;
  },

  onUnload() {
    this._alive = false;
  },

  onInput(e) {
    const input = String(e.detail.value || '').slice(0, 2000);
    this.setData({ input, canSend: !!input.trim() && !this.data.sending });
  },

  onSubmit() {
    if (this.data.sending) return;
    const input = String(this.data.input || '').trim();
    if (!input) {
      wx.showToast({ title: '先输入一个问题', icon: 'none' });
      return;
    }
    return this.send(input);
  },

  updateMessage(id, patch) {
    if (!this._alive) return;
    const index = this.data.messages.findIndex((m) => m.id === id);
    if (index < 0) return;
    const data = {};
    Object.keys(patch || {}).forEach((key) => {
      data['messages[' + index + '].' + key] = patch[key];
    });
    this._scrollTick += 1;
    data.scrollTop = 1000000 + this._scrollTick;
    this.setData(data);
  },

  async send(input) {
    if (this._sending || !this._alive) return;
    this._sending = true;
    const history = this.data.messages
      .filter((m) => m.status === 'done' && (m.role === 'user' || m.role === 'assistant') && m.text)
      .map((m) => ({ role: m.role, content: m.text }));
    const userMessage = { id: nextId('user'), role: 'user', text: input, status: 'done' };
    const aiMessage = {
      id: nextId('ai'),
      role: 'assistant',
      text: '',
      status: 'loading',
      retry: input,
      parentId: userMessage.id
    };
    const messages = this.data.messages.concat([userMessage, aiMessage]).slice(-40);
    this._scrollTick += 1;
    this.setData({
      messages,
      input: '',
      sending: true,
      canSend: false,
      stage: 'thinking',
      scrollTop: 1000000 + this._scrollTick
    });

    try {
      const res = await chatClient.send({
        input,
        history,
        onStage: (s) => {
          if (!this._alive) return;
          this.setData({ stage: s && s.stage === 'searching' ? 'searching' : 'thinking' });
        },
        onPreview: (text) => this.updateMessage(aiMessage.id, { text: String(text || '') })
      });
      this.updateMessage(aiMessage.id, {
        text: res.text,
        status: 'done'
      });
    } catch (err) {
      this.updateMessage(aiMessage.id, {
        text: errorText(err),
        status: 'error'
      });
    } finally {
      this._sending = false;
      if (this._alive) {
        this.setData({
          sending: false,
          stage: 'thinking',
          canSend: !!String(this.data.input || '').trim()
        });
      }
    }
  },

  onRetry(e) {
    if (this._sending) return;
    const id = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id;
    const target = this.data.messages.find((m) => m.id === id && m.status === 'error');
    if (!target) return;
    const messages = this.data.messages.filter((m) => m.id !== target.id && m.id !== target.parentId);
    this.setData({ messages }, () => this.send(target.retry));
  }
});
