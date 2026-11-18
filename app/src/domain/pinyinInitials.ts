/* 零第三方依赖的轻量汉字全音节 + 拼音前缀 + 首字母模糊检索（Wave 2C / 0.1.18 升级）。
   ── 设计原理 ────────────────────────────────────────────────────
   · 复用浏览器 / Node 原生 ICU `Intl.Collator('zh-Hans-u-co-pinyin')` 的标准拼音序，
     对 411 个无声调完整音节分界锚点（吖a..嘬zuo）做二分查找并按字符缓存，
     覆盖全部 20,902 个基本汉字（含用户自定义动作名）；
   · 同时支持：
     1) 首字母检索：`"WT"` / `"wt"` → 卧推，`"YT"` → 引体向上，`"zyglwt"` → 自由杠铃卧推；
     2) 单字/多字不完整拼音前缀：`"Wo"` / `"Wot"` / `"Wotui"` → 卧推，`"Yin"` / `"Yint"` / `"Yinti"` → 引体向上；
     3) 首字母与音节混输：`"zyglwo"` → 自由杠铃卧推，`"fzyin"` → 辅助引体向上；
   · 针对健身动作高频多音字（如「弹力带」tan、「负重/自重」zhong、「单臂/单腿」dan、「提踵/颈后/臂屈伸」等）
     提供精确主读音与多音备选匹配；
   · 纯函数、零网络、零外部包。 */

const PINYIN_COLLATOR = new Intl.Collator('zh-Hans-u-co-pinyin', {
  sensitivity: 'base',
});

/** ICU CLDR `zh-Hans-u-co-pinyin` 在 [\u4e00-\u9fa5] 内的 411 个完整无声调音节起始锚点（升序排列） */
const SYLLABLE_RUNS_RAW =
  '吖a|哎ai|安an|肮ang|凹ao|丷ba|挀bai|扳ban|邦bang|勹bao|卑bei|奔ben|伻beng|屄bi|边bian|灬biao|憋bie|汃bin|冫bing|癶bo|峬bu|嚓ca|偲cai|参can|仓cang|撡cao|冊ce|嵾cen|曽ceng|叉cha|芆chai|辿chan|伥chang|抄chao|车che|抻chen|阷cheng|吃chi|充chong|抽chou|出chu|歘chua|揣chuai|巛chuan|刅chuang|吹chui|旾chun|逴chuo|呲ci|匆cong|凑cou|粗cu|汆cuan|崔cui|邨cun|搓cuo|咑da|呆dai|丹dan|当dang|刀dao|嘚de|扥den|灯deng|氐di|嗲dia|敁dian|刁diao|爹die|丁ding|丟diu|东dong|吺dou|厾du|耑duan|垖dui|吨dun|多duo|妸e|诶ei|奀en|鞥eng|儿er|发fa|帆fan|匚fang|飞fei|分fen|丰feng|覅fiao|仏fo|紑fou|夫fu|旮ga|侅gai|甘gan|冈gang|皋gao|戈ge|给gei|根gen|刯geng|工gong|勾gou|估gu|瓜gua|乖guai|关guan|光guang|归gui|丨gun|呙guo|哈ha|咍hai|佄han|夯hang|茠hao|诃he|黒hei|拫hen|亨heng|噷hm|叿hong|齁hou|乎hu|花hua|怀huai|欢huan|巟huang|灰hui|昏hun|吙huo|丌ji|加jia|戋jian|江jiang|艽jiao|阶jie|巾jin|坕jing|冂jiong|丩jiu|凥ju|姢juan|噘jue|军jun|咔ka|开kai|刊kan|忼kang|尻kao|匼ke|剋kei|肎ken|劥keng|空kong|抠kou|扝ku|夸kua|蒯kuai|宽kuan|匡kuang|亏kui|坤kun|扩kuo|垃la|来lai|兰lan|啷lang|捞lao|仂le|勒lei|崚leng|哩li|俩lia|奁lian|良liang|撩liao|毟lie|拎lin|伶ling|溜liu|囖lo|龙long|瞜lou|噜lu|娈luan|掠lue|抡lun|啰luo|呣m|妈ma|埋mai|嫚man|牤mang|猫mao|嚒me|呅mei|椚men|擝meng|咪mi|宀mian|喵miao|乜mie|民min|名ming|谬miu|摸mo|哞mou|毪mu|拏na|腉nai|囡nan|囔nang|孬nao|疒ne|娞nei|恁nen|能neng|嗯ng|妮ni|拈nian|娘niang|鸟niao|捏nie|囜nin|宁ning|妞niu|农nong|羺nou|奴nu|奻nuan|疟nue|黁nun|郍nuo|喔o|讴ou|妑pa|拍pai|眅pan|乓pang|抛pao|呸pei|喷pen|匉peng|丕pi|囨pian|剽piao|氕pie|姘pin|乒ping|钋po|剖pou|仆pu|七qi|掐qia|千qian|呛qiang|悄qiao|苆qie|亲qin|靑qing|卭qiong|丘qiu|区qu|奍quan|炔que|夋qun|呥ran|穣rang|娆rao|惹re|人ren|扔reng|日ri|戎rong|厹rou|邚ru|挼rua|堧ruan|婑rui|瞤run|捼ruo|仨sa|毢sai|三san|桒sang|掻sao|閪se|森sen|僧seng|杀sha|筛shai|山shan|伤shang|弰shao|奢she|谁shei|申shen|升sheng|尸shi|収shou|书shu|刷shua|衰shuai|闩shuan|双shuang|脽shui|吮shun|说shuo|厶si|忪song|凁sou|苏su|狻suan|夊sui|孙sun|唆suo|他ta|囼tai|坍tan|汤tang|夲tao|忑te|熥teng|剔ti|天tian|旫tiao|帖tie|厅ting|囲tong|偷tou|凸tu|湍tuan|推tui|吞tun|乇tuo|屲wa|歪wai|弯wan|尢wang|危wei|昷wen|翁weng|挝wo|乌wu|夕xi|呷xia|仙xian|乡xiang|灱xiao|些xie|心xin|星xing|凶xiong|休xiu|吁xu|吅xuan|削xue|坃xun|丫ya|恹yan|央yang|幺yao|倻ye|一yi|囙yin|应ying|哟yo|佣yong|优you|込yu|囦yuan|曰yue|晕yun|帀za|災zai|兂zan|匨zang|傮zao|则ze|贼zei|怎zen|増zeng|扎zha|夈zhai|枬zhan|张zhang|佋zhao|蜇zhe|贞zhen|凧zheng|之zhi|中zhong|州zhou|朱zhu|抓zhua|跩zhuai|专zhuan|妆zhuang|隹zhui|宒zhun|拙zhuo|乲zi|宗zong|邹zou|租zu|钻zuan|厜zui|尊zun|嘬zuo';

interface SyllableAnchor {
  readonly ch: string;
  readonly syl: string;
}

const SYLLABLE_ANCHORS: readonly SyllableAnchor[] = SYLLABLE_RUNS_RAW.split('|').map((item) => ({
  ch: item[0],
  syl: item.slice(1),
}));

/** 健身语境高频多音字：首项为健身动作标准读音完整音节，其余为兼容输入备选音节 */
const FITNESS_POLYPHONE_SYLLABLES: Readonly<Record<string, readonly string[]>> = {
  弹: ['tan', 'dan'], // 弹力带 (tan)
  重: ['zhong', 'chong'], // 重量 / 负重 / 自重 (zhong)
  长: ['chang', 'zhang'], // 长凳 / 长杆 (chang)
  单: ['dan', 'shan'], // 单臂 / 单腿 / 单车 (dan)
  颈: ['jing', 'geng'], // 颈后 / 颈前 (jing)
  提: ['ti', 'di'], // 提踵 / 提拉 (ti)
  臂: ['bi', 'bei'], // 臂屈伸 / 直臂 (bi)
  蹲: ['dun', 'cun'], // 深蹲 / 分腿蹲 (dun)
  行: ['xing', 'hang'], // 行走 (xing)
  折: ['zhe', 'she'], // 折刀 (zhe)
  曲: ['qu'], // 曲杆 (qu)
  背: ['bei'], // 背部 (bei)
  膀: ['bang', 'pang'], // 肩膀 (bang)
  扒: ['ba', 'pa'], // 扒 (ba/pa)
  调: ['tiao', 'diao'], // 调节 (tiao)
  侧: ['ce', 'ze'], // 侧平举 (ce)
};

const syllableCache = new Map<string, readonly string[]>();

function asciiAlphaNumChar(ch: string): string {
  if (!ch) return '';
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 48 && code <= 57) return ch;
  if (code >= 65 && code <= 90) return ch.toLowerCase();
  if (code >= 97 && code <= 122) return ch;
  if (code >= 0xff10 && code <= 0xff19) return String.fromCodePoint(code - 0xfee0);
  if (code >= 0xff21 && code <= 0xff3a) return String.fromCodePoint(code - 0xfee0).toLowerCase();
  if (code >= 0xff41 && code <= 0xff5a) return String.fromCodePoint(code - 0xfee0);
  return '';
}

/** 获取单个汉字的候选无声调完整拼音音节列表（首项为主音节；非汉字返回空数组） */
export function charPinyinSyllables(ch: string): readonly string[] {
  if (!ch) return [];
  const cached = syllableCache.get(ch);
  if (cached !== undefined) return cached;

  const poly = FITNESS_POLYPHONE_SYLLABLES[ch];
  if (poly) {
    syllableCache.set(ch, poly);
    return poly;
  }

  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x4e00 || code > 0x9fa5) {
    const empty: readonly string[] = [];
    syllableCache.set(ch, empty);
    return empty;
  }

  let lo = 0;
  let hi = SYLLABLE_ANCHORS.length - 1;
  let matched = '';
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (PINYIN_COLLATOR.compare(ch, SYLLABLE_ANCHORS[mid].ch) >= 0) {
      matched = SYLLABLE_ANCHORS[mid].syl;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const out: readonly string[] = matched ? [matched] : [];
  syllableCache.set(ch, out);
  return out;
}

/** 获取单个字符的主拼音首字母（ASCII 字母数字原样小写保留，标点空白返回空串） */
export function charPinyinInitial(ch: string): string {
  const ascii = asciiAlphaNumChar(ch);
  if (ascii) return ascii;
  const syls = charPinyinSyllables(ch);
  return syls.length > 0 && syls[0].length > 0 ? syls[0][0] : '';
}

/** 提取整段中文/混合文本的主拼音首字母串（例如「自由杠铃卧推」→ `"zyglwt"`） */
export function pinyinInitialsOf(text: string): string {
  let out = '';
  for (const ch of text) {
    out += charPinyinInitial(ch);
  }
  return out;
}

interface SearchToken {
  readonly candidates: readonly string[];
}

function tokenizeForPinyin(text: string): SearchToken[] {
  const tokens: SearchToken[] = [];
  let asciiBuf = '';
  const flushAscii = () => {
    if (asciiBuf) {
      tokens.push({ candidates: [asciiBuf] });
      asciiBuf = '';
    }
  };

  for (const ch of text) {
    const ascii = asciiAlphaNumChar(ch);
    if (ascii) {
      asciiBuf += ascii;
      continue;
    }
    flushAscii();
    const syls = charPinyinSyllables(ch);
    if (syls.length > 0) {
      tokens.push({ candidates: syls });
    }
  }
  flushAscii();
  return tokens;
}

/**
 * 计算纯字母/数字拼音查询在 `text` 中的匹配优先级（越小越优，`-1` 为不命中）：
 * · `0`：从首词元起命中，且多字母片段均为完整音节（或纯首字母缩写），如 `"Yin"` →「引体向上」；
 * · `1`：从句中词元起命中，且多字母片段均为完整音节（或纯首字母缩写），如 `"Yin"` →「反手引体向上」、`"Wo"` / `"WT"` →「自由杠铃卧推」；
 * · `2`：从首词元起命中不完整音节前缀，如 `"Wot"` →「卧推」；
 * · `3`：从句中词元起命中不完整音节前缀，如 `"Wot"` →「自由杠铃卧推」、`"Yin"` →「罗马尼亚硬拉」(ying)；
 * · `-1`：不命中（含空查询或非纯字母数字查询）。
 */
export function pinyinMatchRank(text: string, rawQuery: string): number {
  const normalized = rawQuery
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s'_-]+/g, '');
  if (!normalized || !/^[a-z0-9]+$/.test(normalized)) return -1;

  const tokens = tokenizeForPinyin(text);
  if (tokens.length === 0) return -1;

  const qLen = normalized.length;
  // bestPartialMemo[(ti * (qLen + 1)) + qi]: 0 = unknown, 1 = exact-syllables/initials, 2 = has-partial-syllable, 3 = no-match
  const memo = new Uint8Array((tokens.length + 1) * (qLen + 1));

  const solve = (ti: number, qi: number): number => {
    if (qi === qLen) return 1;
    if (ti >= tokens.length) return 3;
    const key = ti * (qLen + 1) + qi;
    const cached = memo[key];
    if (cached !== 0) return cached;

    let best = 3;
    const remaining = qLen - qi;
    const cands = tokens[ti].candidates;
    for (let c = 0; c < cands.length; c++) {
      const cand = cands[c];
      const maxConsume = cand.length < remaining ? cand.length : remaining;
      for (let len = maxConsume; len >= 1; len--) {
        let prefixOk = true;
        for (let k = 0; k < len; k++) {
          if (cand.charCodeAt(k) !== normalized.charCodeAt(qi + k)) {
            prefixOk = false;
            break;
          }
        }
        if (!prefixOk) continue;
        const sub = solve(ti + 1, qi + len);
        if (sub === 3) continue;
        // 消费 >=2 个字母但未消费完整音节（如 'yin' 匹配 'ying'，或 'wo' 之后 't' 拆自 'tui'）记为前缀模糊
        const stepPartial = len >= 2 && len < cand.length;
        const quality = sub === 1 && !stepPartial ? 1 : 2;
        if (quality < best) {
          best = quality;
          if (best === 1) break;
        }
      }
      if (best === 1) break;
    }
    memo[key] = best;
    return best;
  };

  let bestRank = 99;
  for (let start = 0; start < tokens.length; start++) {
    const q = solve(start, 0);
    if (q === 3) continue;
    const rank = q === 1 ? (start === 0 ? 0 : 1) : start === 0 ? 2 : 3;
    if (rank < bestRank) {
      bestRank = rank;
      if (bestRank === 0) return 0;
    }
  }
  return bestRank < 99 ? bestRank : -1;
}

/**
 * 判断纯字母数字查询 `rawQuery` 是否命中 `text` 的连续拼音首字母 / 音节前缀 / 全拼。
 */
export function matchesPinyinInitials(text: string, rawQuery: string): boolean {
  return pinyinMatchRank(text, rawQuery) >= 0;
}

export const matchesPinyinQuery = matchesPinyinInitials;
