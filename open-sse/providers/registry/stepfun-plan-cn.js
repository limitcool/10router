// StepFun 阶跃星辰开放平台 · 中国站 Step Plan（订阅制，消耗套餐 Credit）。
// Base URL 固定带 /step_plan 前缀：https://api.stepfun.com/step_plan/v1，与按量
// 计费的兄弟渠道 stepfun-cn（/v1，扣现金/代金券）完全独立、额度互不影响。
//
// 关键点：普通渠道调用成功 ≠ 消耗了套餐 Credit；只有打到 /step_plan 前缀的请求
// 才走订阅 Credit（docs/zh/step-plan/overview）。因此本渠道单独入库，便于在
// Combo 里「套餐优先、按量兜底」或按客户端分流。
//
// 官方文档（docs/zh/step-plan/integrations/{quick-start,audio-api,image-api}）：
//   - Chat Completions：https://api.stepfun.com/step_plan/v1/chat/completions
//   - Anthropic Messages：https://api.stepfun.com/step_plan（客户端自动补 /v1/messages）
//   - TTS：/step_plan/v1/audio/speech
//   - ASR：仅 /step_plan/v1/audio/asr/sse（专用 JSON+SSE 格式，非 OpenAI 转录格式），
//     本渠道不暴露 STT 行，避免误接到不存在的 /audio/transcriptions。
//
// 支持的模型（实测 GET /step_plan/v1/models 与文档一致）：step-5-preview,
// step-3.7-flash, step-3.5-flash(-2603), step-router-v1, stepaudio-2.5-tts。
// 对话式音频（stepaudio-2.5-chat/realtime）不入库。
//
// 图像已下架（2026-09-21）：step-image-edit-2 与 /step_plan/v1/images/{generations,edits}
// 随官方公告于 2026-10-10 停服（实测下线前已持续 503），故不再暴露 kind:"image"
// 模型、imageConfig 与 serviceKinds 中的 "image"。
export default {
  id: "stepfun-plan-cn",
  priority: 64,
  alias: "stepp-cn",
  aliases: ["step-plan-cn", "sfp-cn", "sfpcn", "stepfun-plan-cn"],
  display: {
    name: "StepFun CN Plan",
    icon: "bolt",
    color: "#2E5BFF",
    textIcon: "SF",
    website: "https://platform.stepfun.com/step-plan",
    notice: {
      apiKeyUrl: "https://platform.stepfun.com/interface-key",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.stepfun.com/step_plan/v1/chat/completions",
    validateUrl: "https://api.stepfun.com/step_plan/v1/models",
  },
  models: [
    { id: "step-5-preview", name: "Step 5 Preview" },
    { id: "step-3.7-flash", name: "Step 3.7 Flash" },
    { id: "step-3.5-flash", name: "Step 3.5 Flash" },
    { id: "step-3.5-flash-2603", name: "Step 3.5 Flash 2603" },
    // 智能路由模型：Step Plan 专属，按任务复杂度自动调度上游模型。
    { id: "step-router-v1", name: "Step Router V1" },
    { id: "stepaudio-2.5-tts", name: "StepAudio 2.5 TTS", kind: "tts" },
  ],
  serviceKinds: ["llm", "imageToText", "tts"],
  // 套餐 Credit 无公开查询 API（/step_plan/v1/accounts 为 404），不做用量卡片。
  features: {},
  ttsConfig: {
    baseUrl: "https://api.stepfun.com/step_plan/v1/audio/speech",
    authType: "apikey",
    authHeader: "bearer",
    format: "openai",
    defaultVoice: "cixingnansheng",
  },
};
