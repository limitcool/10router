// StepFun 阶跃星辰开放平台 · 国际站 Step Plan（订阅制，消耗套餐 Credit）。
// Base URL 固定带 /step_plan 前缀：https://api.stepfun.ai/step_plan/v1，与按量
// 计费的兄弟渠道 stepfun（/v1，扣现金/代金券）完全独立、额度互不影响。
//
// 中国站同构命名为 stepfun-plan-cn。官方文档（docs/en/step-plan/*）：
//   - Chat Completions：https://api.stepfun.ai/step_plan/v1/chat/completions
//   - Anthropic Messages：https://api.stepfun.ai/step_plan（客户端自动补 /v1/messages）
//   - 支持模型：step-5-preview, step-3.7-flash, step-3.5-flash(-2603),
//     step-router-v1, stepaudio-2.5-tts, stepaudio-2.5-asr
//   - 国际站文档未列出 /step_plan 图像模型（图像模型亦将于 2026-10-10 下线），
//     故本渠道不暴露 image；ASR 仅走专用 /step_plan/v1/audio/asr/sse，同样不暴露 STT 行。
//
// 套餐 Credit 按 1M Credit ≈ $1 统一计量；月池月末清零、加油包独立 30 天。
export default {
  id: "stepfun-plan",
  priority: 66,
  alias: "stepp",
  aliases: ["step-plan", "sfp", "stepfun-plan"],
  display: {
    name: "StepFun Plan",
    icon: "bolt",
    color: "#2E5BFF",
    textIcon: "SF",
    website: "https://platform.stepfun.ai/step-plan",
    notice: {
      apiKeyUrl: "https://platform.stepfun.ai/interface-key",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.stepfun.ai/step_plan/v1/chat/completions",
    validateUrl: "https://api.stepfun.ai/step_plan/v1/models",
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
  // 套餐 Credit 无公开查询 API，不做用量卡片。
  features: {},
  ttsConfig: {
    baseUrl: "https://api.stepfun.ai/step_plan/v1/audio/speech",
    authType: "apikey",
    authHeader: "bearer",
    format: "openai",
    defaultVoice: "cixingnansheng",
  },
};
