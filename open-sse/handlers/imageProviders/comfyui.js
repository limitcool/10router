// ComfyUI — local image provider
import { nowSec } from "./_base.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";

const DEFAULT_BASE_URL = PROVIDER_MEDIA["comfyui"]?.imageConfig?.baseUrl || "http://127.0.0.1:8188";

function parseSize(sizeStr, defaultW = 512, defaultH = 512) {
  if (!sizeStr || typeof sizeStr !== "string") return [defaultW, defaultH];
  const parts = sizeStr.toLowerCase().split("x").map((p) => parseInt(p.trim(), 10));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return [parts[0], parts[1]];
  }
  return [defaultW, defaultH];
}

export default {
  noAuth: true,
  useExecutor: true,

  // Stubs for interface compatibility
  buildUrl: () => DEFAULT_BASE_URL,
  buildHeaders: () => ({ "Content-Type": "application/json" }),
  buildBody: (_model, body) => ({ prompt: body.prompt }),

  async executeViaExecutor(model, body, credentials, log) {
    const baseUrl = credentials?.baseUrl || credentials?.apiKey || DEFAULT_BASE_URL;
    const promptText = body.prompt;
    if (!promptText) throw new Error("Missing prompt");

    // 1. Discover available checkpoints
    let chosenCkpt = null;
    try {
      const infoRes = await fetch(`${baseUrl}/object_info/CheckpointLoaderSimple`);
      if (infoRes.ok) {
        const info = await infoRes.json();
        const available = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
        if (Array.isArray(available) && available.length > 0) {
          // If model name matches any available checkpoint, prefer it
          const match = available.find((c) =>
            c.toLowerCase().includes((model || "").toLowerCase()) ||
            ((model || "").toLowerCase().includes("1-5") && c.includes("1-5")) ||
            ((model || "").toLowerCase().includes("sdxl") && c.toLowerCase().includes("sdxl")) ||
            ((model || "").toLowerCase().includes("flux") && c.toLowerCase().includes("flux"))
          );
          chosenCkpt = match || available[0];
        }
      }
    } catch (err) {
      log?.warn?.("COMFYUI", `Failed to inspect checkpoints: ${err.message}`);
    }

    if (!chosenCkpt) {
      chosenCkpt = "v1-5-pruned-emaonly.safetensors";
    }

    // Determine dimensions
    const isSdxlOrFlux = /sdxl|flux/i.test(chosenCkpt) || /sdxl|flux/i.test(model || "");
    const defaultDim = isSdxlOrFlux ? 1024 : 512;
    const [width, height] = parseSize(body.size, defaultDim, defaultDim);

    const steps = Number(body.steps) || (isSdxlOrFlux ? 25 : 20);
    const cfg = Number(body.cfg_scale || body.cfg) || 7.5;
    const seed = Number.isInteger(body.seed) ? body.seed : Math.floor(Math.random() * 1e14);
    const negativePrompt = body.negative_prompt || "blurry, bad quality, distorted, extra limbs";

    // 2. Build standard SD / SDXL txt2img graph
    const workflow = {
      "3": {
        class_type: "KSampler",
        inputs: {
          model: ["4", 0],
          positive: ["6", 0],
          negative: ["7", 0],
          latent_image: ["5", 0],
          seed,
          steps,
          cfg,
          sampler_name: "euler",
          scheduler: "normal",
          denoise: 1,
        },
      },
      "4": {
        class_type: "CheckpointLoaderSimple",
        inputs: {
          ckpt_name: chosenCkpt,
        },
      },
      "5": {
        class_type: "EmptyLatentImage",
        inputs: {
          width,
          height,
          batch_size: Number(body.n) || 1,
        },
      },
      "6": {
        class_type: "CLIPTextEncode",
        inputs: {
          clip: ["4", 1],
          text: promptText,
        },
      },
      "7": {
        class_type: "CLIPTextEncode",
        inputs: {
          clip: ["4", 1],
          text: negativePrompt,
        },
      },
      "8": {
        class_type: "VAEDecode",
        inputs: {
          samples: ["3", 0],
          vae: ["4", 2],
        },
      },
      "9": {
        class_type: "SaveImage",
        inputs: {
          filename_prefix: "10Router",
          images: ["8", 0],
        },
      },
    };

    // 3. Queue prompt to ComfyUI
    const promptRes = await fetch(`${baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow }),
    });

    if (!promptRes.ok) {
      const errText = await promptRes.text();
      throw new Error(`ComfyUI /prompt error (${promptRes.status}): ${errText}`);
    }

    const { prompt_id } = await promptRes.json();
    if (!prompt_id) throw new Error("ComfyUI did not return prompt_id");

    log?.debug?.("COMFYUI", `Queued job ${prompt_id}, checkpoint: ${chosenCkpt}`);

    // 4. Poll /history/{prompt_id} until completed (max 180s)
    const startTime = Date.now();
    const TIMEOUT_MS = 180_000;
    let historyEntry = null;

    while (Date.now() - startTime < TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const histRes = await fetch(`${baseUrl}/history/${prompt_id}`);
      if (!histRes.ok) continue;

      const historyData = await histRes.json();
      if (historyData[prompt_id]) {
        historyEntry = historyData[prompt_id];
        break;
      }
    }

    if (!historyEntry) {
      throw new Error(`ComfyUI image generation timed out after ${TIMEOUT_MS / 1000}s`);
    }

    // 5. Extract output images
    const outputs = historyEntry.outputs || {};
    const imageList = [];
    for (const nodeOutput of Object.values(outputs)) {
      if (Array.isArray(nodeOutput.images)) {
        for (const img of nodeOutput.images) {
          imageList.push(img);
        }
      }
    }

    if (imageList.length === 0) {
      throw new Error("ComfyUI completed but returned no output images");
    }

    // 6. Download image bytes and encode to base64
    const data = [];
    for (const img of imageList) {
      const viewUrl = `${baseUrl}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || "")}&type=${encodeURIComponent(img.type || "output")}`;
      const imgRes = await fetch(viewUrl);
      if (!imgRes.ok) {
        throw new Error(`Failed to fetch generated image from ComfyUI (${imgRes.status})`);
      }
      const arrayBuffer = await imgRes.arrayBuffer();
      const b64 = Buffer.from(arrayBuffer).toString("base64");
      data.push({ b64_json: b64 });
    }

    return {
      created: nowSec(),
      data,
    };
  },

  normalize: (responseBody) => responseBody,
};

