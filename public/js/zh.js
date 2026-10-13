// Simplified → Taiwan Traditional Chinese conversion.
// OpenCC (cn → twp) is loaded lazily the first time Chinese is needed. Conversion runs on whole
// passages at display/export time, never on individual streaming deltas, so phrases split across
// deltas (头+发 → 頭髮) still convert correctly.

import { fullwidthPunctuation } from "./text.js";

let converter = null;
let loading = null;
let version = 0;

// Changes whenever the converter does, so cached conversions can be redone with OpenCC once it loads.
export function zhConverterVersion() {
  return version;
}

export function ensureZhConverter(src = "/vendor/opencc-cn2t.js") {
  if (converter) return Promise.resolve(true);
  if (loading) return loading;
  loading = new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve(false);
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      try {
        converter = globalThis.OpenCC.Converter({ from: "cn", to: "twp" });
        version += 1;
        resolve(true);
      } catch {
        resolve(false);
      }
    };
    script.onerror = () => resolve(false);
    document.head.append(script);
  });
  return loading;
}

export function setZhConverter(fn) {
  converter = fn;
  version += 1;
}

export function toTraditional(text) {
  if (!text) return text;
  return converter ? converter(text) : fallbackConvert(text);
}

// Display text for a language: only Chinese needs conversion (and full-width punctuation).
export function displayText(text, language) {
  return language === "zh" ? toTraditional(fullwidthPunctuation(text)) : text;
}

// Minimal fallback used only when OpenCC fails to load. It deliberately omits characters whose
// Traditional form depends on context (里/裡, 后/後, 云/雲, 划/劃, 干/乾/幹, 发/發/髮 …).
const PHRASES = [
  ["头发", "頭髮"],
  ["理发", "理髮"],
  ["人工智能", "人工智慧"],
  ["机器学习", "機器學習"],
  ["软件", "軟體"],
  ["硬件", "硬體"],
  ["智能", "智慧"],
  ["实时", "即時"],
  ["数据", "資料"],
  ["网络", "網路"],
  ["默认", "預設"],
  ["屏幕", "螢幕"],
  ["视频", "影片"],
  ["音频", "音訊"],
  ["用户", "使用者"],
  ["日历", "日曆"],
  ["以后", "以後"],
  ["之后", "之後"],
  ["后来", "後來"],
  ["然后", "然後"],
  ["最后", "最後"],
  ["这里", "這裡"],
  ["那里", "那裡"],
  ["哪里", "哪裡"],
  ["里面", "裡面"],
  ["云端", "雲端"],
  ["出发", "出發"],
  ["发展", "發展"],
  ["发布", "發布"],
  ["开发", "開發"],
];

const CHARS = new Map(
  Object.entries({
    并: "並", 与: "與", 为: "為", 个: "個", 们: "們", 说: "說", 请: "請", 谢: "謝", 讲: "講", 语: "語",
    译: "譯", 话: "話", 词: "詞", 证: "證", 识: "識", 论: "論", 议: "議", 讯: "訊", 让: "讓", 该: "該",
    详: "詳", 误: "誤", 读: "讀", 现: "現", 录: "錄", 实: "實", 时: "時", 业: "業", 产: "產", 杂: "雜",
    体: "體", 会: "會", 对: "對", 处: "處", 连: "連", 线: "線", 软: "軟", 开: "開", 变: "變", 应: "應",
    湾: "灣", 紧: "緊", 关: "關", 将: "將", 长: "長", 从: "從", 来: "來", 这: "這", 两: "兩", 么: "麼",
    数: "數", 网: "網", 络: "絡", 计: "計", 优: "優", 问: "問", 题: "題", 决: "決", 况: "況", 状: "狀",
    态: "態", 动: "動", 过: "過", 标: "標", 资: "資", 类: "類", 项: "項", 页: "頁", 区: "區", 块: "塊",
    设: "設", 导: "導", 观: "觀", 众: "眾", 听: "聽", 麦: "麥", 风: "風", 声: "聲", 频: "頻", 码: "碼",
    际: "際", 国: "國", 电: "電", 脑: "腦", 机: "機", 学: "學", 习: "習", 认: "認", 样: "樣", 级: "級",
    总: "總", 结: "結", 构: "構", 选: "選", 择: "擇", 输: "輸", 删: "刪", 简: "簡", 转: "轉", 换: "換",
    医: "醫", 疗: "療", 财: "財", 务: "務", 营: "營", 销: "銷", 键: "鍵", 钥: "鑰", 顶: "頂", 滚: "滾",
    权: "權", 预: "預", 测: "測", 试: "試", 验: "驗", 错: "錯", 丢: "丟", 别: "別", 额: "額", 场: "場",
    战: "戰", 专: "專", 门: "門", 约: "約", 归: "歸", 纳: "納", 继: "繼", 续: "續", 显: "顯", 隐: "隱",
    调: "調", 载: "載", 启: "啟", 闭: "閉", 释: "釋", 发: "發", 历: "歷", 于: "於",
  }),
);

export function fallbackConvert(text) {
  let converted = text;
  for (const [from, to] of PHRASES) converted = converted.replaceAll(from, to);
  let result = "";
  for (const char of converted) result += CHARS.get(char) ?? char;
  return result;
}
