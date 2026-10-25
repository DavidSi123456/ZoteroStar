/* Pure metadata matching; shared by the Zotero plugin and offline tests. */
var JournalRankCore = (() => {
  const TAG_PREFIX = "期刊星级/";
  const SOURCE_PREFIX = "评级来源/AJG2024/";
  const LEGACY_UNRATED = "期刊/未评级";
  const LEGACY_STARS = /^⭐{1,5} 期刊$/u;
  const LEVELS = Object.freeze({ "4*": 5, "4": 4, "3": 3, "2": 2, "1": 1 });

  function normalize(title) {
    return String(title || "").normalize("NFKD").toLowerCase()
      .replace(/\p{M}/gu, "")
      .replace(/\s*\(the\)\s*$/, "").replace(/^the\s+/, "")
      .replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
  }
  function tagForLevel(level) {
    return TAG_PREFIX + (/^[1-5]$/.test(String(level)) ? level : "未评级");
  }
  function isRatingTag(tag) {
    return /^期刊星级\/(?:[1-5]|未评级)$/.test(tag);
  }
  function ownedTag(tag) {
    return isRatingTag(tag) || LEGACY_STARS.test(tag) || tag === LEGACY_UNRATED
      || /^评级来源\/AJG2024\/(?:4\*|[1-4])$/.test(tag);
  }
  function createEngine(dataset) {
    const journals = new Map();
    for (const row of dataset.journals) {
      if (!(row.grade in LEVELS)) throw new Error("Invalid AJG grade: " + row.grade);
      const key = normalize(row.title);
      if (journals.has(key) && journals.get(key).grade !== row.grade) {
        throw new Error("Conflicting journal grades: " + row.title);
      }
      journals.set(key, row);
    }
    const abbreviations = new Map(Object.entries(dataset.abbreviations || {})
      .map(([title, abbreviation]) => [normalize(title), abbreviation]));
    function rating(itemType, title) {
      if (itemType !== "journalArticle") return { eligible: false, stars: null, reason: "不属于期刊文章" };
      const text = String(title || "").trim();
      if (!text) return { eligible: true, stars: null, reason: "期刊名称未填写" };
      if (/\b(?:SSRN|arxiv|NBER|RePEc)\b|working papers?|International Corporate Finance eJournal/i.test(text)) {
        return { eligible: true, stars: null, reason: "工作论文或预印本平台" };
      }
      const row = journals.get(normalize(text));
      return row ? { eligible: true, stars: LEVELS[row.grade], grade: row.grade, journal: row.title }
        : { eligible: true, stars: null, reason: "AJG 2024 未收录" };
    }
    function abbreviation(itemType, title, metadataAbbreviation) {
      if (!["journalArticle", "preprint"].includes(itemType)) return "";
      const text = String(title || "").trim();
      if (!text) return "";
      return abbreviations.get(normalize(text)) || String(metadataAbbreviation || "").trim() || text;
    }
    function desiredTags(itemType, title, currentTags) {
      const result = rating(itemType, title);
      const tags = currentTags.filter(t => !ownedTag(t.tag)).map(t => ({ ...t }));
      if (result.eligible) {
        tags.push({ tag: tagForLevel(result.stars), type: 0 });
        if (result.grade) tags.push({ tag: SOURCE_PREFIX + result.grade, type: 0 });
      }
      return tags;
    }
    return Object.freeze({ rating, abbreviation, desiredTags, journalCount: journals.size });
  }
  function equalTags(a, b) {
    const keys = tags => new Set(tags.map(t => `${t.tag}\u0000${t.type || 0}`));
    const aa = keys(a), bb = keys(b);
    return aa.size === bb.size && [...aa].every(t => bb.has(t));
  }
  function filterTags(existing, level) {
    const tags = new Set([...existing].filter(t => !isRatingTag(t)));
    if (level !== "all") tags.add(tagForLevel(level));
    return tags;
  }
  return Object.freeze({ normalize, createEngine, equalTags,
    filterTags, tagForLevel, isRatingTag, ownedTag, LEVELS, TAG_PREFIX });
})();
if (typeof module !== "undefined") module.exports = JournalRankCore;
