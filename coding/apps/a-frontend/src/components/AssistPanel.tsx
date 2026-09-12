import { useEffect, useState } from "react";
import {
  ApiError,
  clearModel,
  getSettings,
  saveAssist,
  saveModel,
  testModel,
  type ModelTestResult,
  type SettingsPayload,
} from "../api";
import type { AssistMode, StyleLevel } from "../../../../src/shared/types";

// 阶段4 的开关与模型配置（PRD §7.3 §8.2 §9.2）。
// 设计约束：改动即时保存（这是一台机器上的单人工具，不需要「提交」这一步），
// 但任何一次失败都要在原地说话，不能静默退回默认值。

const MODE_LABELS: Record<AssistMode, { title: string; desc: string }> = {
  // 这个选项已经从界面上去掉了（下面 MODE_OPTIONS 不含它）：
  // “纯人工”本来就是两个开关都关的那个组合（PRD §6.6 第一行），
  // 再给一个模式卡片只会让人在三个入口里找北。服务端仍然收 manual（老设置读得到）。
  manual: { title: "人工模式", desc: "只用你写的原文，一个字节都不改。" },
  rules: {
    title: "本地规则模式",
    desc: "离线跑，不联网、不花钱；句式偏模板。",
  },
  user_model: { title: "我的模型", desc: "用你配的服务端点和密钥，效果最好。" },
};

/** 界面上能选的模式。manual 不在这里，原因见上面那条注释。 */
const MODE_OPTIONS: AssistMode[] = ["rules", "user_model"];

/** 档位清单：首页面板和会话页那个「档位」下拉共用一份，别写两处。 */
export const STYLE_LEVELS: StyleLevel[] = ["轻微", "明显", "浓郁"];

interface Props {
  /** 会话页不需要重新拉一份配置，创建页用不到这个回调。 */
  onLoaded?: (settings: SettingsPayload) => void;
}

export default function AssistPanel({ onLoaded }: Props) {
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [note, setNote] = useState<{ text: string; level: "info" | "error" } | null>(
    null,
  );
  const [test, setTest] = useState<ModelTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  /** 连通性测试在同主机上探到的真接口前缀：只摆一个按钮，点一下才改框，绝不自动改用户填的东西。 */
  const [suggested, setSuggested] = useState<string | null>(null);

  const reload = async () => {
    try {
      const next = await getSettings();
      setSettings(next);
      setBaseUrl(next.model.baseUrl);
      setModelId(next.model.modelId);
      onLoaded?.(next);
    } catch (err) {
      setNote({
        text:
          err instanceof ApiError && err.status === 403
            ? "还没完成本机验证。"
            : "读取设置失败。",
        level: "error",
      });
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!settings) {
    return (
      <section className="form-section assist-panel">
        <h2>幕后工具 <span className="optional-tag">选配</span></h2>
        <p className="hint">{note?.text ?? "加载中…"}</p>
      </section>
    );
  }

  const { assist, model } = settings;
  // Skill 的标识、版本、路径、上限不再给 A 看（作者 2026-09-12）；PRD §8.3 要的「坏了要告诉人」
  // 由 assistProblems 兑现：只看状态，不读内部名字。
  const assistProblems = skillProblems(settings);

  const patchAssist = async (patch: Partial<typeof assist>) => {
    setBusy(true);
    setNote(null);
    try {
      const result = await saveAssist(patch);
      setSettings({ ...settings, assist: result.assist });
    } catch (err) {
      setNote({
        text:
          err instanceof ApiError ? `没保存成功（${err.code}）` : "没保存成功。",
        level: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const FIELD_NAMES: Record<string, string> = {
    baseUrl: "服务地址",
    modelId: "模型名",
    apiKey: "密钥",
  };

  const handleSaveModel = async () => {
    setBusy(true);
    setNote(null);
    // 保存没生效时上一轮的测试结果已经不代表当前配置了，留着只会误导。
    setTest(null);
    try {
      const result = await saveModel({
        baseUrl,
        modelId,
        apiKey: apiKey || undefined,
      });
      setSettings({ ...settings, model: result.model });
      if (result.accepted) {
        // 只成功才清空密钥框：没保存还把人家刚粘进去的东西抹了，是上一版的坑。
        setApiKey("");
        setNote({
          text: "已保存到本机内存。密钥不会写进任何文件，重启服务后要重填。",
          level: "info",
        });
      } else {
        const missing = (result.missing ?? []).map((f) => FIELD_NAMES[f] ?? f);
        setNote({
          text: `没保存：${missing.join("、") || "有一项"}是空的，内存里仍是上一次的配置${
            model.baseUrl ? `（地址 ${model.baseUrl}）` : ""
          } —— 测试与实际生成打的都是那一套，不是你这会儿填的。`,
          level: "error",
        });
      }
    } catch (err) {
      setNote({
        text:
          err instanceof ApiError
            ? `保存失败（${err.code}）：${err.detail ?? ""}`
            : "保存失败。",
        level: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  // 测的是**框里这三项**（不写内存）：以前只测已保存的那套，屏幕上写着用户刚填的地址、
  // 报出来的却是上一次保存的地址 —— 那一条错在用户看来完全没道理。
  const handleTest = async () => {
    setBusy(true);
    setTest(null);
    setSuggested(null);
    const result = await testModel({
      baseUrl: baseUrl.trim(),
      modelId: modelId.trim(),
      // 密钥框留空 = 沿用内存里已保存的那把（界面读不回明文，本来就是空的）。
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
    setTest(result);
    if (!result.ok && result.suggestedBaseUrl) setSuggested(result.suggestedBaseUrl);
    setBusy(false);
  };

  const handleClearModel = async () => {
    setBusy(true);
    await clearModel();
    setSettings({
      ...settings,
      model: { ...model, hasKey: false, modelId: "", baseUrl: "" },
    });
    setBaseUrl("");
    setModelId("");
    setApiKey("");
    setTest(null);
    setNote({ text: "密钥与端点已清除。", level: "info" });
    setBusy(false);
  };

  return (
    <section className="form-section assist-panel">
      <h2>幕后工具 <span className="optional-tag">选配</span></h2>
      <p className="hint">
        两条链路各自独立：关掉摘要时 A
        自己写的过程也算「已确认」；两个开关都关时这条会话就是纯人工聊天。
      </p>

      <div className="assist-modes">
        {(MODE_OPTIONS as AssistMode[]).map((mode) => (
          <label
            key={mode}
            className={
              assist.mode === mode ? "assist-mode active" : "assist-mode"
            }
          >
            <input
              type="radio"
              name="assist-mode"
              checked={assist.mode === mode}
              disabled={busy}
              onChange={() => patchAssist({ mode })}
            />
            <strong>{MODE_LABELS[mode].title}</strong>
            <span className="hint">{MODE_LABELS[mode].desc}</span>
          </label>
        ))}
      </div>

      {assist.mode === "user_model" && !model.hasKey && (
        <p className="assist-warning">
          三项还没填齐（地址 / 模型名 / 密钥），现在点两个按钮会直接失败（正文不会被改动）。
        </p>
      )}

      <div className="assist-switches">
        <label className="switch">
          <input
            type="checkbox"
            checked={assist.aiStyleEnabled}
            disabled={busy || assist.mode === "manual"}
            onChange={(e) => patchAssist({ aiStyleEnabled: e.target.checked })}
          />
          润色成 AI 口吻
        </label>
        <label className="switch">
          <input
            type="checkbox"
            checked={assist.analysisEnabled}
            disabled={busy || assist.mode === "manual"}
            onChange={(e) => patchAssist({ analysisEnabled: e.target.checked })}
          />
          分析摘要
        </label>
        <label className="switch">
          档位
          <select
            value={assist.styleLevel}
            disabled={
              busy || !assist.aiStyleEnabled || assist.mode === "manual"
            }
            onChange={(e) =>
              patchAssist({ styleLevel: e.target.value as StyleLevel })
            }
          >
            {STYLE_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
      </div>
      {assist.mode === "manual" && (
        <p className="assist-warning">
          这台机器上一次存的是「人工模式」（正文和摘要都不生成）。
          这个选项已经从界面上去掉了：上面选一种就能开始用，
          或者把上面的两个开关都关掉也是同样的效果。
        </p>
      )}
      {!assist.aiStyleEnabled && assist.analysisEnabled && (
        <p className="hint">
          关了润色但留着摘要：B 会看到「你写的原文 +
          一段依据原文反推的思路」。摘要永远依据最终正文，所以这条组合是合法的。
        </p>
      )}

      {assist.mode === "user_model" && (
        <div className="assist-model">
          <h3>
            我的模型（
            {model.keySource === "env"
              ? "密钥来自环境变量"
              : model.keySource === "manual"
                ? "密钥来自本机设置"
                : "三项还没配齐"}
            ）
          </h3>
          <label>
            Base URL
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
            />
          </label>
          <label>
            模型名
            <input
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="model-id"
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                model.hasKey
                  ? "已保存，留空表示不改这一项"
                  : "只存在服务进程内存里"
              }
            />
          </label>
          {/* 框里这套与内存里生效的那套不一致时一定显出来：不然“报错里的地址”和
              “屏幕上的地址”不同会被当成报错本身错了（实跑撞过）。 */}
          {baseUrl.trim() !== (model.baseUrl ?? "").trim() && (
            <p className="hint">
              {model.baseUrl
                ? `当前生效的是 ${model.baseUrl} —— 框里这套还没保存。`
                : "内存里还没有生效的地址；没保存之前测试只能拿框里这几项去试。"}
            </p>
          )}
          <div className="row">
            <button onClick={handleSaveModel} disabled={busy}>
              保存
            </button>
            {/* 不再因为「内存里还没密钥」而置灰：置灰只能让人先去保存，反而把两套值分叉的坑留得更深。
                缺什么就测一次，让服务端指名说缺哪一项。 */}
            <button onClick={handleTest} disabled={busy}>
              连通性测试
            </button>
            <button
              onClick={handleClearModel}
              disabled={busy || !model.hasKey}
              className="ghost"
            >
              清除密钥
            </button>
          </div>
          {test && (
            <p className={test.ok ? "assist-ok" : "assist-warning"}>
              {test.ok
                ? `通了（${test.latencyMs ?? "?"}ms）${
                    test.testedBaseUrl ? `，打的是 ${test.testedBaseUrl}` : ""
                  }${test.drafted ? "；这套还只在框里、没保存" : ""}。`
                : `${test.message ?? "调不通"}${
                    test.endpointUrl || test.endpointPath
                      ? `〔实际请求 ${test.endpointUrl ?? test.endpointPath}${
                          test.httpStatus ? ` · HTTP ${test.httpStatus}` : ""
                        }〕`
                      : ""
                  }`
              }
            </p>
          )}
          {/* 探到了活的接口前缀就给一键填上：省得在「我填的没错」和「它说不对」之间来回。
              点了才算数，不点框里还是你填的 —— 绝不偷偷改用户输入。 */}
          {suggested ? (
            <div className="row">
              <button
                onClick={() => {
                  setBaseUrl(suggested);
                  setSuggested(null);
                  setTest(null);
                  setNote({
                    text: `地址已改成 ${suggested}，再点一次「连通性测试」看看`,
                    level: "info",
                  });
                }}
              >
                按这个填：{suggested}
              </button>
            </div>
          ) : null}
          <p className="hint">
            密钥只在服务进程内存里：不落库、不进日志、任何接口都不回显（PRD
            §8.2）。重启服务、换进程都要重填。
          </p>
        </div>
      )}

      {/* 平时不占地方；只有“某一顶用不了”时才说一句（PRD §8.3：禁用对应辅助，人工聊天照常）。 */}
      {assistProblems.length > 0 && (
        <div className="assist-skills">
          {assistProblems.map((line) => (
            <p key={line} className="assist-warning">
              {line}
            </p>
          ))}
        </div>
      )}

      {note && (
        <p className={note.level === "error" ? "assist-error" : "hint"}>
          {note.text}
        </p>
      )}
    </section>
  );
}

// 只说“某一顶用不了 + 聊天不受影响”，不报标识/版本/路径/上限（那些是看日志的东西）。
function skillProblems(settings: SettingsPayload): string[] {
  const out: string[] = [];
  if (settings.skillConfigError)
    out.push("AI 能力的配置读不了，现在只能你自己写原文。");
  if (settings.skills.aiStyle.status !== "ok")
    out.push("「润色成 AI 口吻」现在用不了，这个开关先灰着；正文照常能发。");
  if (settings.skills.analysis.status !== "ok")
    out.push("「分析摘要」现在用不了，这个开关先灰着；正文照常能发。");
  return out;
}
