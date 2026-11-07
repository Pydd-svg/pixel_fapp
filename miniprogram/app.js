/**
 * app.js —— 全局入口
 * 职责（A 岗）：
 *   1. wx.cloud.init（环境 ID 来自 services/config.js）
 *   2. 生成稳定的 sessionId（仅埋点用，不上云）
 *   3. 暴露启动耗时，供 L4「冷启动到可输入 ≤ 2s」自测
 * 注意：不得在此处持有任何 API Key。
 */
const config = require('./services/config');

App({
  globalData: {
    envReady: false,
    envError: '',
    sessionId: '',
    launchTs: 0
  },

  onLaunch() {
    const launchTs = Date.now();
    this.globalData.launchTs = launchTs;
    this.globalData.sessionId = buildSessionId();

    if (!wx.cloud) {
      this.globalData.envError = '当前基础库不支持 wx.cloud，请确认调试基础库 ≥ 3.15.1';
      console.error('[app] wx.cloud 不存在', this.globalData.envError);
      return;
    }

    // 没填真实环境 ID 时不要 init：
    // init 不会报错，但之后每次 callFunction 都会 -601034 刷一屏红字。
    // 直连模型通道不依赖云开发，跳过完全不影响出卡。
    if (!config.CLOUD_ENABLED) {
      this.globalData.envReady = false;
      this.globalData.envError = 'CLOUD_NOT_CONFIGURED';
      this.globalData.version = config.APP_VERSION;
      console.info('[app] 云开发未启用（预览包直连模式），已跳过 wx.cloud.init；出卡走 services/llm.js 直连通道');
      return;
    }

    try {
      wx.cloud.init({
        env: config.CLOUD_ENV_ID,
        traceUser: true
      });
      this.globalData.envReady = true;
      console.info('[app] cloud init ok, env =', config.CLOUD_ENV_ID);
    } catch (err) {
      // env 填错是最常见的启动失败原因，这里给出可读提示而不是直接崩
      this.globalData.envError = 'wx.cloud.init 失败：' + (err && err.message ? err.message : String(err));
      console.error('[app]', this.globalData.envError);
    }

    // 版本号挂在 globalData，dev 页可读，用于「长按版本号进 Demo」的备用入口
    this.globalData.version = config.APP_VERSION;
  },

  onShow() {
    this.globalData.showTs = Date.now();
  }
});

function buildSessionId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return 's_' + Date.now().toString(36) + '_' + rand;
}
