/**
 * ⚠️ 本文件由 scripts/build-assets.js 自动生成，请勿手改。
 * 源文件：shared/fixtures/*.json
 * 生成时间：2026-11-07T01:21:21.252Z
 */
module.exports = {
  cards: {
    "card-chao-wan": {
      "status": "success",
      "error_code": null,
      "is_followup": false,
      "followup_question": "",
      "decision_data": {
        "card_title": "初音未来手办决策卡",
        "category": "chao_wan",
        "budget_band": "200-300",
        "tags": [
          "新手入坑",
          "按300元假设"
        ],
        "recommendations": [
          {
            "type": "首选方案",
            "name": "GSC 粘土人系列",
            "price_expectation": "200-280元",
            "pros": "可动性好配件多，二手流通快，验货点明确",
            "cons": "盗版多，盒底防伪与面部涂装必须核对"
          },
          {
            "type": "备选方案",
            "name": "景品系列（同价位）",
            "price_expectation": "120-200元",
            "pros": "正版渠道多，价格友好，适合先练手",
            "cons": "涂装细节一般，品控波动大"
          }
        ],
        "red_flags": [
          "低于官方定价6折的现货，基本是散货或翻新盒",
          "盒底无镭射防伪贴，或编号查不到，直接放弃",
          "「自用出」但只拍远景，多为翻新盒遮瑕疵"
        ],
        "search_keyword": "初音未来 粘土人 正版 验货",
        "knowledge_refs": [
          "chao_wan_001",
          "chao_wan_004",
          "cross_001"
        ],
        "confidence": "medium",
        "disclaimer": "内容由 AI 生成，仅供参考 · 不构成购买建议"
      },
      "meta": {
        "elapsed_ms": 7400,
        "channel": "agent",
        "cache_hit": false
      }
    },
    "card-headphone": {
      "status": "success",
      "error_code": null,
      "is_followup": false,
      "followup_question": "",
      "decision_data": {
        "card_title": "100元内蓝牙耳机决策卡",
        "category": "digital",
        "budget_band": "50-100",
        "tags": [
          "通勤",
          "按100元假设"
        ],
        "recommendations": [
          {
            "type": "首选方案",
            "name": "手机厂商入门TWS",
            "price_expectation": "79-99元",
            "pros": "连接稳定，系统级弹窗，售后有网点",
            "cons": "音质一般，无主动降噪，延迟不适合打游戏"
          }
        ],
        "red_flags": [
          "标「原装正品」却比官方价低一半的，多为翻新或拼装",
          "虚标续航：标40小时实际单次多在4小时内"
        ],
        "search_keyword": "百元 蓝牙耳机 学生 实测 延迟",
        "knowledge_refs": [
          "digital_001",
          "digital_002",
          "cross_006"
        ],
        "confidence": "medium",
        "disclaimer": "内容由 AI 生成，仅供参考 · 不构成购买建议"
      },
      "meta": {
        "elapsed_ms": 6900,
        "channel": "agent",
        "cache_hit": false
      }
    },
    "card-laptop": {
      "status": "success",
      "error_code": null,
      "is_followup": false,
      "followup_question": "",
      "decision_data": {
        "card_title": "6000元笔记本决策卡",
        "category": "laptop",
        "budget_band": "5000-6000",
        "tags": [
          "学生党",
          "轻度游戏",
          "按6000元假设"
        ],
        "recommendations": [
          {
            "type": "首选方案",
            "name": "核显轻薄本",
            "price_expectation": "5000-5500元",
            "pros": "写代码加LOL够用，2.8K屏续航一天",
            "cons": "无独显，跑3A吃力，内存建议直接16G"
          }
        ],
        "red_flags": [
          "6000内标「电竞本」多为二线贴牌清库存，售后网点少",
          "开学季「校园特供机」常缩水，下单前比对官网配置单"
        ],
        "search_keyword": "2026 笔记本 学生 6000 核显 推荐",
        "knowledge_refs": [
          "laptop_001",
          "laptop_004",
          "cross_011"
        ],
        "confidence": "medium",
        "disclaimer": "内容由 AI 生成，仅供参考 · 不构成购买建议"
      },
      "meta": {
        "elapsed_ms": 8200,
        "channel": "agent",
        "cache_hit": false
      }
    },
    "followup-1": {
      "status": "success",
      "error_code": null,
      "is_followup": true,
      "followup_question": "想买哪一类？大概预算多少？比如「初音手办 300 以内」这样说我就能直接出卡。",
      "decision_data": null,
      "meta": {
        "elapsed_ms": 3100,
        "channel": "agent",
        "cache_hit": false
      }
    }
  },
  verify: {
    "ok": {
      "status": "success",
      "search_summary": {
        "recent_verdict": "近期口碑整体较好，存在批次性品控问题。",
        "community_feedback": [
          "B站评测：该批次腿部涂装偶有轻微溢色，不影响观赏。",
          "贴吧讨论：A店售后补件比B店快，价差不大建议选A。",
          "小红书笔记：盒内衬纸若已破损，多为拆封回封。"
        ],
        "caution_alert": "二手市场出现大量翻新盒，务必要求卖家拍特写视频。",
        "sources_hint": [
          "B站评测区",
          "贴吧讨论帖",
          "小红书避雷笔记"
        ]
      },
      "meta": {
        "elapsed_ms": 11200,
        "degraded": false
      }
    },
    "empty": {
      "status": "empty",
      "search_summary": {
        "recent_verdict": "暂未检索到有效口碑",
        "community_feedback": [],
        "caution_alert": "",
        "sources_hint": []
      },
      "meta": {
        "elapsed_ms": 14800,
        "degraded": false
      }
    }
  },
  byCategory: {
    "chao_wan": "card-chao-wan",
    "digital": "card-headphone",
    "laptop": "card-laptop"
  }
};
