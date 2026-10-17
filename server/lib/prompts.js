'use strict';

const { payloadBlock } = require('./json');
const { round2, distributeEvenly } = require('./calc');

/** 单题判分的提示词（要求严格 JSON 输出） */
function buildGradeMessages({ stem, refAnswer, rubricType, rubricText, items, answer }) {
  const rubricItems = rubricType === 'items'
    ? items.map((it, i) => ({ index: i, text: it.text, points: it.points }))
    : [{ index: 0, text: rubricText || '整体给分', points: items.points }];

  const payload = {
    task: 'grade',
    rubricType,
    stem,
    refAnswer: refAnswer || '',
    items: rubricItems,
  };

  const lines = [
    '你是一位严谨的阅卷老师。请严格依据给定的评分标准，对学生的作答逐项判分。',
    '',
    '【题目】',
    stem,
    '',
    '【参考答案】',
    refAnswer || '（未提供参考答案）',
    '',
    '【评分标准】',
    ...rubricItems.map((it) => `${it.index + 1}. ${it.text} —— 满分 ${it.points} 分`),
    '',
    '【学生作答】',
    answer && answer.text ? answer.text : '（学生没有提供文字作答，请看附图）',
    '',
    '【判分要求】',
    '1. 必须逐项给出得分，不能只给总分。',
    '2. 每一项的 reason 必须写清楚：依据的是哪一条评分标准、为什么给这个分。',
    '3. score 不得超过该条满分，也不得为负数。',
    '4. confidence 是你对这一项判分的把握程度，0~1 之间的小数；把握不足时给低值，并在 reason 里说明为什么存疑。',
    '5. 只输出 JSON，不要输出任何解释性文字、不要加代码块标记。',
    '',
    '【输出格式】',
    '{"items":[{"index":0,"score":0,"reason":"","confidence":0.9}],"comment":"一句话总评"}',
    payloadBlock(payload),
  ];

  const content = [{ type: 'text', text: lines.join('\n') }];
  const images = (answer && Array.isArray(answer.images)) ? answer.images : [];
  images.forEach((path) => {
    content.push({ type: 'image_url', image_url: { url: path } });
  });

  return [
    { role: 'system', content: '你是一位中学老师，负责按评分标准阅卷。你只输出严格的 JSON。' },
    { role: 'user', content },
  ];
}

/**
 * 图片作答的判分提示词。
 * 学生交上来的是手写/拍照的作答时，不看评分标准——让 AI 直接看图自己判。
 * 题干和参考答案仍然给它：那是理解题意用的，不算"评分标准"。
 */
function buildAutoGradeMessages({ stem, refAnswer, points, answer, seq }) {
  const payload = {
    task: 'grade',
    rubricType: 'auto',
    mode: 'auto',
    stem,
    refAnswer: refAnswer || '',
    items: [{ index: 0, text: 'AI 自主评判', points: Number(points) || 0 }],
  };

  const lines = [
    '你是一位有经验的阅卷老师。学生这一题交上来的是手写/拍照的作答，请你**直接看图**自己判分。',
    '',
    '【题目】' + (seq ? '第 ' + seq + ' 题' : ''),
    stem,
    '',
    '【参考答案】',
    refAnswer || '（未提供参考答案，完全依靠你自己的专业判断）',
    '',
    '【本题满分】' + (Number(points) || 0) + ' 分',
    '',
    '【学生作答】',
    answer && answer.text ? answer.text : '（没有文字，只有下面的照片）',
    '',
    '【判分要求】',
    '1. 认认真真看清楚照片里学生写了什么：公式、计算过程、文字表述、画的图都算作答内容。',
    '2. **不要去找评分标准条目**，本题没有要求你逐条对照；按你自己作为老师的判断给一个总分。',
    '3. 照片可能是整份答题卡的连拍，里面有多道题。**只看属于这一题的部分**，其他题的作答不要算进本题。',
    '4. 照片看不清、找不到这一题的作答时，按能看清的部分给分，并把 confidence 给低，在 reason 里说明。',
    '5. reason 要写清楚：哪些地方对了、哪里扣了分，让老师一眼能看出你的判断依据。',
    '6. score 不能超过本题满分，也不能为负。',
    '7. 只输出 JSON，不要输出任何解释性文字、不要加代码块标记。',
    '',
    '【输出格式】',
    '{"items":[{"index":0,"score":0,"reason":"","confidence":0.9}],"comment":"一句话总评"}',
    payloadBlock(payload),
  ];

  const content = [{ type: 'text', text: lines.join('\n') }];
  const images = (answer && Array.isArray(answer.images)) ? answer.images : [];
  images.forEach((url) => {
    content.push({ type: 'image_url', image_url: { url } });
  });

  return [
    { role: 'system', content: '你是一位中学老师，直接看学生的作答照片判分。你只输出严格的 JSON。' },
    { role: 'user', content },
  ];
}

/**
 * 「整份图片作答」的判分提示词。
 * 老师交上来的是**整张答题卡**的照片（不拆题、不挂到任何题目上），
 * 所以这一路只能给一个整卷总分：拿不到题号，也就不该假装逐题给分。
 */
/** 错题清单里每一条最多留多长，防止 AI 写成大段作文 */
const WRONG_TEXT_MAX = 200;
/** 错题清单最多留多少条 */
const WRONG_MAX = 30;

function trimText(value, max) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max || WRONG_TEXT_MAX);
}

/**
 * 归一化 AI 报出来的错题清单。
 * 只要「题号 + 错在哪」，**不要每题分数**：分数仍然是整卷那一个总分。
 * 字段缺、类型怪、整条空白、超长都在这儿收拾干净，脏数据不许进库。
 */
function normalizeWrongList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  raw.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const no = trimText(item.no === undefined ? item.seq : item.no, 40);
    const where = trimText(item.where === undefined ? item.at : item.where);
    const issue = trimText(item.issue === undefined ? item.reason : item.issue);
    // 既没说在哪、也没说错什么，这条没有信息量，丢掉
    if (!where && !issue) return;
    // 每道错题扣多少分（老数据没有就按 0）
    const d = Number(item.deduct);
    const deduct = Number.isFinite(d) && d >= 0 ? round2(d) : 0;
    out.push({ no, where, issue, deduct });
  });
  return out.slice(0, WRONG_MAX);
}

function buildWholeGradeMessages({ paperName, fullMarks, passLine, answer }) {
  const full = Number(fullMarks) || 0;
  const payload = {
    task: 'grade_whole',
    paperName: paperName || '',
    fullMarks: full,
    passLine: Number(passLine) || 0,
  };

  const lines = [
    '你是一位有经验的阅卷老师。下面是一名学生**整份答题卡**的照片（可能有好几张，按顺序拍下来）。',
    '这份卷子的作答**没有按题目切分**，你手上也没有题目清单，所以请**按整卷给一个总分**，不要虚构题号去逐题列分。',
    '但你要**把做错的题挑出来**，写清是**哪一题**、**错在哪一处**、**错成了什么**。',
    '',
    '【试卷】' + (paperName ? '《' + paperName + '》' : '（未命名）'),
    '【整卷满分】' + full + ' 分',
    passLine ? '【及格线】' + passLine + ' 分' : '',
    '',
    '【判分要求】',
    '1. 认认真真把照片里的每一道题都看一遍：公式、计算过程、文字表述、画的图都算作答内容。',
    '   **只看学生最终写下的答案，自己独立判断对错**——卷面上已有的批改痕迹（打叉、打勾、分数、「错/对」批注、涂改）一律不要采信，不要照着它们判断。',
    '2. **优先按照片里印着的评分机制扣分**：先仔细看照片里有没有印分值或扣分规则（如「每题 4 分」「选择题每题 3 分」「错一题扣 3 分」）。印了就严格照它；没印才用下面默认规则。',
    '   默认规则（照片里没印分值时才用）：数清卷面总题数，每题平均 = 满分 ÷ 总题数；选择、判断这类小题按平均分扣，解答题按步骤给部分分（对一步给一步的分）。',
    '3. reason 要写清楚：哪些部分答得好、哪些地方扣了分，让老师一眼能看出你的判断依据。',
    '4. **错题清单（wrong）要逐条写清**，字段含义：',
    '   · no —— 题号。**只写卷面上学生自己写的或印着的题号**（如 "3"、"三"、"3(2)"）。',
    '     **卷面上看不清题号、或者根本没写题号，就把 no 留空字符串 ""**，绝对不要自己猜、不要按顺序编号。',
    '   · deduct —— 这道错题**扣多少分**（跟在题号后面）。按上面第 2 条定的机制：印了分值就扣该题分值，没印就按平均分扣；半对扣一半，只扣明显做错的，没做错的一分不扣。',
    '   · where —— 错在**哪一处**：哪一步、哪一问、哪一行、哪个结论句（如 "第 2 步受力分析"、"最后一问的结论"）。',
    '   · issue —— 错在**什么**：说明错的具体内容（如 "漏了摩擦力的方向，导致合外力算错"、"单位写成 N，应为 N/kg"）。',
    '   「过程不严谨/有待提高」这类空话不要写，必须指到具体的式子、结论或文字上。',
    '5. **逐题仔细核对，别漏报错题**：凡是有错、或者拿不准的题，都列进 wrong（拿不准的也在 issue 里写清"可能错 / 不确定"）。只有整份都确定做对才给空数组 []。',
    '6. 照片不完整、看不清、有明显缺页时，按能看清的部分给分，把 confidence 给低，在 reason 里说明；**看不清的题不要直接跳过当没看见，也单独标出来**。',
    '7. **总分 = 满分 − 所有错题的 deduct 之和**：score 就等于这个数（扣分加起来就是扣掉的总分）。score 不能超过满分，也不能为负。',
    '8. 只输出 JSON，不要输出任何解释性文字、不要加代码块标记。',
    '',
    '【输出格式】',
    '{"score":0,"reason":"","confidence":0.9,"comment":"一句话总评",' +
      '"wrong":[{"no":"3","deduct":3,"where":"第 2 步受力分析","issue":"漏了摩擦力方向，合外力算错"}]}',
    payloadBlock(payload),
  ].filter((line) => line !== '').join('\n');

  const content = [{ type: 'text', text: lines }];
  const images = (answer && Array.isArray(answer.images)) ? answer.images : [];
  images.forEach((url) => {
    content.push({ type: 'image_url', image_url: { url } });
  });

  return [
    {
      role: 'system',
      content: '你是一位中学老师，看着整份答题卡的照片，优先按照片里印的评分机制逐题判对错并标扣分，总分=满分减扣分。你只输出严格的 JSON。',
    },
    { role: 'user', content },
  ];
}

/**
 * 「AI 分配分值」的提示词：老师给了一份卷子的**整卷总分**，请把它按权重分到每道大题。
 * 大题下面的小题分值由算法平均分（见 distributeEvenly），不在这里让 AI 逐小题编。
 */
function buildAllocateMessages({ fullMarks, questions }) {
  const full = Number(fullMarks) || 0;
  const list = (questions || []).map((q) => ({
    seq: q.seq,
    stem: q.stem || '',
    refAnswer: q.refAnswer || '',
    itemCount: Number(q.itemCount) || 0,
    rubricText: q.rubricText || '',
  }));

  const lines = [
    '你是一位负责命题配分的老师。老师已经给了一份卷子的**整卷总分**，请你把它**按权重分配到每道大题**。',
    '',
    '【整卷总分】' + full + ' 分',
    '【大题清单】' + (list.length ? '' : '（空）'),
    ...list.map((q) =>
      '第 ' + q.seq + ' 题（下面有 ' + q.itemCount + ' 个得分点）\n  题干：' + q.stem +
      (q.refAnswer ? '\n  参考答案：' + q.refAnswer : '') +
      (q.rubricText ? '\n  评分标准：' + q.rubricText : '')
    ),
    '',
    '【分配要求】',
    '1. 按每道大题的难度、工作量、重要程度给权重：难的、综合的、步骤多的多给，简单识记的少给，不要平均主义。',
    '2. 所有大题的分值**加在一起必须正好等于整卷总分**，一分不多、一分不少。',
    '3. 每道大题的分值尽量取整数或 0.5 的倍数；实在除不尽再保留一位小数。',
    '4. 只输出 JSON，不要输出任何解释性文字、不要加代码块标记。',
    '',
    '【输出格式】',
    '{"allocations":[{"seq":1,"points":20},{"seq":2,"points":30}]}',
    payloadBlock({ task: 'allocate', fullMarks: full, questions: list }),
  ];

  return [
    { role: 'system', content: '你是命题配分老师，只把整卷总分按权重分到每道大题。你只输出严格的 JSON。' },
    { role: 'user', content: lines.join('\n') },
  ];
}

/**
 * 归一化 AI 分配出来的分值：按 seq 归位到每道大题，夹到 0~满分，
 * 并把总和规整成**正好等于整卷总分**（先按比例缩放、最后一项补差）。
 * AI 要是没给对（缺字段、全 0、总和不对），就退化成平均分，绝不写坏数据。
 */
function normalizeAllocation(parsed, fullMarks, questions) {
  const full = Number(fullMarks) || 0;
  const n = (questions || []).length;
  if (!n) return [];
  const seqs = questions.map((q) => q.seq);

  const fromRaw = (raw) => {
    if (!Array.isArray(raw)) return null;
    const bySeq = new Map();
    raw.forEach((a, i) => {
      if (!a || typeof a !== 'object') return;
      const key = a.seq !== undefined && a.seq !== null
        ? Number(a.seq)
        : (a.index !== undefined && a.index !== null ? Number(a.index) + 1 : i + 1);
      let pts = Number(a.points);
      if (!Number.isFinite(pts) || pts < 0) pts = 0;
      bySeq.set(key, pts);
    });
    return bySeq;
  };

  const bySeq = fromRaw(parsed && parsed.allocations);
  if (!bySeq) {
    return distributeEvenly(full, n).map((points, i) => ({ seq: seqs[i], points }));
  }

  const rawPts = seqs.map((s) => (bySeq.has(s) ? bySeq.get(s) : 0));
  let sum = rawPts.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    return distributeEvenly(full, n).map((points, i) => ({ seq: seqs[i], points }));
  }

  // 先夹到不超过满分，再按比例缩放到总和 = full
  const clamped = rawPts.map((p) => Math.min(p, full));
  sum = clamped.reduce((a, b) => a + b, 0);
  const scaled = seqs.map((s, i) => ({ seq: s, points: round2(clamped[i] * full / sum) }));
  const scaledSum = round2(scaled.reduce((a, b) => a + b.points, 0));
  scaled[scaled.length - 1].points = round2(scaled[scaled.length - 1].points + (full - scaledSum));
  return scaled;
}

/** 手写/拍照答案的识别提示词（与 /api/import/parse 里的提示词保持同一格式约定） */
function buildOcrMessages(imageUrls, hint) {
  const text = [
    '你是手写试卷识别助手。下面是同一名学生的答题卡照片，可能有好几张。',
    '请把照片里学生写的答案逐题转写成文字，尽量保留原始表达，不要批改、不要评分、不要补充。',
    '输出格式：每题一行，以「第N题（图M）」开头，M 是这一题的内容主要出现在第几张照片里。例如：',
    '第1题（图1） 根据 h=1/2gt² 得 t=√(2h/g)=3s',
    '第2题（图2） 受力分析如图所示，合力为零',
    '',
    '只输出识别结果。',
    payloadBlock({ task: 'ocr', imageCount: (imageUrls || []).length, hintText: hint || '' }),
  ].join('\n');

  const content = [{ type: 'text', text }];
  (imageUrls || []).forEach((url) => {
    content.push({ type: 'image_url', image_url: { url } });
  });

  return [
    { role: 'system', content: '你是手写体识别助手，只输出识别到的文字。' },
    { role: 'user', content },
  ];
}

module.exports = {
  buildGradeMessages, buildAutoGradeMessages, buildWholeGradeMessages, buildOcrMessages,
  buildAllocateMessages, normalizeAllocation,
  normalizeWrongList, WRONG_MAX,
};
