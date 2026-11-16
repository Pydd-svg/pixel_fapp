/**
 * pages/dev —— 开发自检页（**不上线导航**，首页长按版本号进入）
 * 归属：A 岗。
 * 用途：P1 通道验证、埋点导出、样例灌入、限额重置。
 * 提交前请确认它不在任何正式入口里可达 —— 只留长按版本号这一条暗门。
 */
const config = require('../../services/config');
const aiClient = require('../../services/aiClient');
const metrics = require('../../services/metrics');
const cache = require('../../services/cache');
const storage = require('../../services/storage');

Page({
  data: {
    output: '',
    busy: false,
    envText: '',
    adapter: '',
    llmText: '',
    flags: {},
    summaryText: '',
    usageText: ''
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const app = getApp();
    const g = (app && app.globalData) || {};
    const q1 = storage.checkQuota('decide', config.LIMIT);
    const q2 = storage.checkQuota('verify', config.LIMIT);
    this.setData({
      envText: (g.envReady
        ? 'init ok'
        : g.envError === 'CLOUD_NOT_CONFIGURED'
        ? '云开发未配置（直连模型照常）'
        : 'init FAIL' + (g.envError ? '：' + g.envError : '')) + ' · ' + config.CLOUD_ENV_ID,
      adapter: aiClient._internals.resolveAdapter(config.BOT_ID_DECIDE),
      llmText:
        (config.LLM.enabled ? config.LLM.mode : 'off') +
        ' · ' +
        ((config.LLM.models && config.LLM.models.join(' → ')) || config.LLM.model) +
        ' · key…' +
        String(config.LLM.apiKey || '').slice(-6),
      flags: {
        useFixture: config.FEATURE.useFixture,
        useFallback: config.FEATURE.useFallback,
        demoMode: aiClient.isDemoMode(),
        quota: config.FEATURE.quota,
        secCheck: config.FEATURE.secCheck
      },
      summaryText: JSON.stringify(metrics.summary(), null, 2),
      usageText:
        config.FEATURE.quota === false
          ? '限额已关闭 · 今日已用 ' + q1.used + ' 次决策 / ' + q2.used + ' 次查证'
          : '决策 ' + q1.used + '/' + q1.cap + ' · 查证 ' + q2.used + '/' + q2.cap
    });
  },

  /** 单次直调，打印原始返回（D2 通道验证用） */
  async onProbe() {
    if (this.data.busy) return;
    this.setData({ busy: true, output: '调用中，自由模型排队时最长等 20 秒…' });
    const r = await aiClient.probe({ rawInput: '初音手办 300以内' });
    if (!r.ok) {
      this.setData({ busy: false, output: '失败：' + r.error + '\n\n通道：' + r.source });
      return;
    }
    this.setData({
      busy: false,
      output:
        '通道=' + r.channel + '  解析level=' + r.parse_level + '  ok=' + r.parse_ok + '  长度=' + r.raw_length + '\n' +
        '———— 原始返回 ————\n' + r.raw
    });
  },

  onCopyOutput() {
    if (!this.data.output) return;
    wx.setClipboardData({ data: this.data.output, success: () => wx.showToast({ title: '已复制', icon: 'none' }) });
  },

  onClearOutput() {
    this.setData({ output: '' });
  },

  onToggleFixture() {
    config.FEATURE.useFixture = !config.FEATURE.useFixture;
    this.refresh();
    wx.showToast({ title: '样例通道 ' + (config.FEATURE.useFixture ? '开' : '关'), icon: 'none' });
  },

  onToggleDemo() {
    const next = !aiClient.isDemoMode();
    aiClient.setDemoMode(next);
    this.refresh();
    wx.showToast({ title: '演示模式 ' + (next ? '开' : '关'), icon: 'none' });
  },

  onToggleFallback() {
    config.FEATURE.useFallback = !config.FEATURE.useFallback;
    this.refresh();
  },

  onToggleSecCheck() {
    config.FEATURE.secCheck = !config.FEATURE.secCheck;
    this.refresh();
    wx.showToast({ title: '内容安全 ' + (config.FEATURE.secCheck ? '开' : '关'), icon: 'none' });
  },

  /** 埋点导出：写剪贴板，粘到文件里就是测试记录（P3-3.5） */
  onExportMetrics() {
    const text = metrics.exportJSON();
    wx.setClipboardData({
      data: text,
      success: () => wx.showModal({ title: '埋点已复制', content: '共 ' + metrics.list().length + ' 条，粘贴到 eval/reports/ 下的 json 文件即可', showCancel: false })
    });
  },

  onResetUsage() {
    storage.resetUsage();
    this.refresh();
    wx.showToast({ title: '次数已重置', icon: 'none' });
  },

  onClearCache() {
    cache.clear();
    wx.showToast({ title: '需求缓存已清', icon: 'none' });
  },

  /** 主模型被限流后会冷却 90 秒；这里手动清掉，想立刻验证主模型就点它 */
  onResetCooldown() {
    const order = aiClient._internals.resetModelCooldown();
    this.refresh();
    wx.showToast({ title: '已清冷却，当前首选 ' + order[0], icon: 'none' });
  },

  /**
   * 云函数连通自检：一次点清三件事
   *   1) 函数有没有上传（没上传会 -501000 FunctionName not found）
   *   2) 云环境和当前 AppID 是不是同一个账号（不是会 -601034 没有权限）
   *   3) 环境变量 LLM_API_KEY / LLM_MODEL 有没有配
   */
  async onCloudPing() {
    this.setData({ output: '正在检查云函数…' });
    // 预览包里云开发是整包关掉的（游客 AppID 不属于这个云环境，调了只会 -601034）
    if (!config.CLOUD_ENABLED) {
      this.setData({
        output:
          '本预览包为「游客 AppID + 直连模型」版，未启用云开发。\n\n' +
          '· 出卡走 services/llm.js 的直连通道，与云函数无关\n' +
          '· 内容安全、云函数兜底在本包里自动跳过，属设计内行为，不是故障\n\n' +
          '要恢复云端能力：换成自己的 AppID → 开通云开发 → 把 config.js 的 PREVIEW_NO_CLOUD 改成 false。'
      });
      return;
    }
    if (!wx.cloud) {
      this.setData({ output: '当前基础库不支持 wx.cloud，无法检查' });
      return;
    }
    try {
      const r = await wx.cloud.callFunction({
        name: config.CLOUD_FN_NAME,
        data: { action: 'health' }
      });
      const res = (r && r.result) || {};
      if (res.code !== 0) {
        this.setData({ output: '云函数已响应，但自检失败 ❌\n\ncode=' + res.code + ' ' + (res.msg || '') });
        return;
      }
      const d = res.data || {};
      const llm = d.llm || {};
      const se = d.search || {};
      const lines = [
        '云函数已部署 ✅  自检总耗时 ' + (d.totalMs || 0) + 'ms',
        '',
        '【大模型】' + (llm.ok ? '可用 ✅' : '不可用 ❌'),
        '  Key：' + (llm.keyReady ? llm.key : '未配置'),
        '  端点：' + (llm.baseUrl || '-'),
        '  模型：' + (llm.model || '-'),
        llm.warn ? '  ⚠️ ' + llm.warn : '',
        '  可用模型：' + (llm.models && llm.models.length ? llm.models.join(' / ') : '未取到'),
        '  /models ' + (llm.modelsMs != null ? llm.modelsMs + 'ms' : '-') +
          ' · 试生成 ' + (llm.chatMs != null ? llm.chatMs + 'ms' : '未测'),
        llm.error ? '  错误：' + llm.error : '',
        '',
        '【联网搜索】' + (se.ok ? '可用 ✅' : se.keyReady ? '调用失败 ❌' : '未配置 ⚠️'),
        '  Key：' + (se.keyReady ? se.key : '未配置'),
        '  Provider：' + (se.provider || '-') + (se.providerExplicit ? '（显式）' : '（默认 / 自动识别）'),
        '  耗时：' + (se.ms != null ? se.ms + 'ms' : '-') + ' · 命中 ' + (se.count || 0) + ' 条',
        se.reason ? '  说明：' + se.reason : '',
        se.sample ? '  示例：' + se.sample : ''
      ].filter(Boolean);
      this.setData({ output: lines.join('\n') });
      wx.showToast({
        title: llm.ok ? (se.ok ? '模型与搜索都正常' : '模型正常，搜索待查') : '模型不可用',
        icon: 'none'
      });
    } catch (e) {
      const msg = (e && (e.errMsg || e.message)) || String(e);
      let hint = '未知原因';
      if (/-5010\d\d|FUNCTION_NOT_FOUND|云函数不存在/i.test(msg)) hint = '函数没上传：右键 cloudfunctions/aiFallback → 上传并部署';
      else if (/-6010\d\d|没有权限|云开发/i.test(msg)) hint = '云环境与当前 AppID 不匹配，或云开发没开通';
      this.setData({ output: '云函数调用失败 ❌\n\n' + msg + '\n\n' + hint });
      wx.showToast({ title: '调用失败', icon: 'none' });
    }
  },

  /** 灌样例数据：不调 AI，直接看 C 的样式是否吃全字段（契约 §6.3） */
  onInjectFixture() {
    let mock = null;
    try {
      mock = require('../../mock/index.js');
    } catch (e) {
      wx.showToast({ title: '样例未生成，先跑 build-assets', icon: 'none' });
      return;
    }
    const card = mock.cards['card-laptop'];
    wx.navigateTo({
      url: '/pages/result/result?from=dev',
      success: (res) => {
        res.eventChannel.emit('card', card);
        res.eventChannel.emit('context', { rawInput: '想买台笔记本电脑 6000以内' });
      }
    });
  }
});
