const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../core.js');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../rankings.json'), 'utf8'));
const engine = core.createEngine(data);

test('real AJG data maps grades and exact journal identities conservatively', () => {
  assert.equal(engine.journalCount, 1822);
  assert.equal(engine.rating('journalArticle', 'The American Economic Review').stars, 5);
  assert.equal(engine.rating('journalArticle', 'QUARTERLY JOURNAL OF ECONOMICS').stars, 5);
  assert.equal(engine.rating('journalArticle', 'Journal of Development Economics').stars, 3);
  assert.equal(engine.rating('journalArticle', 'Unknown Journal').stars, null);
  assert.equal(engine.rating('journalArticle', '').stars, null);
  assert.equal(engine.rating('journalArticle', 'SSRN Electronic Journal').stars, null);
  assert.equal(engine.rating('preprint', 'American Economic Review').eligible, false);
  for (const row of data.journals) {
    assert.equal(engine.rating('journalArticle', row.title).stars, core.LEVELS[row.grade]);
  }
});

test('journal abbreviations use common names, then metadata, then full title', () => {
  for (const [title, expected] of [
    ['The American Economic Review', 'AER'], ['The Quarterly Journal of Economics', 'QJE'],
    ['Journal of Development Economics', 'JDE'], ['Journal of Finance', 'JF'],
    ['The Review of Financial Studies', 'RFS']
  ]) assert.equal(engine.abbreviation('journalArticle', title, 'metadata abbreviation'), expected);
  assert.equal(engine.abbreviation('journalArticle', 'A New Journal', 'ANJ'), 'ANJ');
  assert.equal(engine.abbreviation('journalArticle', '经济研究', ''), '经济研究');
  assert.equal(engine.abbreviation('book', 'American Economic Review', 'AER'), '');
});

test('legacy title emojis migrate without changing unrelated tags or reading status', () => {
  const original = [{ tag: '⭐⭐⭐⭐⭐ 期刊' }, { tag: '评级来源/AJG2024/4*' },
    { tag: '期刊/未评级' }, { tag: '主题/养老金' }, { tag: '/unread', type: 1 }];
  const next = engine.desiredTags('journalArticle', 'Journal of Development Economics', original);
  assert(next.some(x => x.tag === '期刊星级/3'));
  assert(next.some(x => x.tag === '评级来源/AJG2024/3'));
  assert(next.some(x => x.tag === '/unread' && x.type === 1));
  assert(next.some(x => x.tag === '主题/养老金'));
  assert(!next.some(x => x.tag.includes('⭐')));
  assert.equal(next.filter(x => core.isRatingTag(x.tag)).length, 1);
  assert(core.equalTags(next, engine.desiredTags('journalArticle', 'Journal of Development Economics', next)));
  const unknown = engine.desiredTags('journalArticle', '', next);
  assert(unknown.some(x => x.tag === '期刊星级/未评级'));
  assert(!unknown.some(x => x.tag.startsWith('评级来源/')));
  assert.deepEqual(engine.desiredTags('book', '', next), next.filter(x => !core.ownedTag(x.tag)));
});

test('star filtering preserves every non-rating filter', () => {
  const result = core.filterTags(new Set(['主题/养老金', '往年课程', '期刊星级/5']), '3');
  assert.deepEqual([...result].sort(), ['主题/养老金', '往年课程', '期刊星级/3'].sort());
  assert.deepEqual([...core.filterTags(result, 'all')].sort(), ['主题/养老金', '往年课程'].sort());
});

function mockRuntime() {
  const saved = [], columns = [], unregister = [], observers = new Map(), prefs = new Map();
  const items = new Map();
  function makeItem(id, type, title, tags = [], libraryID = 1) {
    const item = { id, itemTypeID: type, libraryID, deleted: false, fields: { publicationTitle: title },
      tags: structuredClone(tags), saveCount: 0,
      isRegularItem: () => !['attachment', 'note'].includes(type),
      getField(name) { return this.fields[name] || ''; },
      loadDataType: async () => {}, getTags() { return structuredClone(this.tags); },
      setTags(tags) { this.tags = structuredClone(tags); },
      async save(options) {
        assert.equal(options.skipDateModifiedUpdate, true);
        this.saveCount++; saved.push(this.id);
        // Actual notifier callbacks can fire for the plugin's own tag save.
        for (const observer of observers.values()) observer.notify('modify', 'item', [this.id]);
      }
    };
    items.set(id, item); return item;
  }
  const searches = [];
  class Search {
    constructor() { this.conditions = []; }
    addCondition(condition, operator, value = '') { this.conditions.push({ condition, operator, value }); }
    loadDataType = async () => {};
    toJSON() { return { name: this.name, conditions: structuredClone(this.conditions) }; }
    fromJSON(json) { Object.assign(this, structuredClone(json)); }
    async saveTx() { if (!searches.includes(this)) searches.push(this); }
  }
  const errors = [];
  const Zotero = {
    File: { getResourceAsync: async () => JSON.stringify(data) },
    ItemTypes: { getName: id => id },
    ItemTreeManager: {
      registerColumn(option) { const key = option.pluginID + ':' + option.dataKey; columns.push({ ...option, key }); return key; },
      unregisterColumn: key => unregister.push(key), refreshColumns() {}
    },
    Notifier: { registerObserver(o) { observers.set('observer', o); return 'observer'; }, unregisterObserver: id => observers.delete(id) },
    getMainWindows: () => [],
    Libraries: { getAll: () => [{ libraryID: 1, libraryType: 'user', editable: true }],
      get: id => ({ libraryType: id === 2 ? 'group' : 'user', editable: id !== 3 }) },
    Items: { getAll: async () => [...items.values()], getAsync: async id => items.get(id) },
    Searches: { getAll: async () => searches }, Search,
    DB: { executeTransaction: async f => f() },
    Promise: { delay: async () => {} },
    Prefs: { get: n => prefs.get(n), set: (n, v) => prefs.set(n, v) },
    logError: error => errors.push(String(error))
  };
  const sandbox = { Zotero, Services: { appShell: { hiddenDOMWindow: { setTimeout, clearTimeout } } }, module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../plugin.js'), 'utf8'), sandbox);
  const plugin = new sandbox.module.exports('journal-stars@test', 'file:///test/', core);
  return { plugin, makeItem, columns, observers, searches, errors, unregister };
}

test('mocked lifecycle registers two sortable columns and reuses existing sidebar searches', async () => {
  const m = mockRuntime();
  const journal = m.makeItem(1, 'journalArticle', 'American Economic Review', [{ tag: '⭐⭐⭐⭐⭐ 期刊' }]);
  const book = m.makeItem(2, 'book', '', [{ tag: '往年课程' }]);
  const oldSearch = { name: '期刊评级 ① ★★★★★', conditions: [
    { condition: 'tag', operator: 'is', value: '⭐⭐⭐⭐⭐ 期刊' },
    { condition: 'date', operator: 'isAfter', value: '2020' }
  ], loadDataType: async () => {}, toJSON() { return { name: this.name, conditions: this.conditions }; },
    fromJSON(json) { Object.assign(this, json); }, saveTx: async () => {} };
  m.searches.push(oldSearch);
  await m.plugin.start();
  assert.equal(m.columns.length, 2);
  assert(m.columns.some(x => x.label === '期刊星级' && x.dataProvider(journal) === '5'));
  assert(m.columns.some(x => x.label === '期刊简称' && x.dataProvider(journal) === 'AER'));
  assert.equal(m.searches.length, 6);
  assert.equal(oldSearch.conditions[0].value, '期刊星级/5');
  assert.equal(oldSearch.conditions[1].value, '2020');
  assert.equal(book.saveCount, 0);
  assert.equal(journal.saveCount, 1); // own notifications do not cause an infinite save loop
  await m.plugin.stop();
  assert.equal(m.observers.size, 0);
  assert.equal(m.unregister.length, 2);
  assert.deepEqual(m.errors, []);
});

test('new import, journal edit, missing metadata and later completion all update automatically', async () => {
  const m = mockRuntime();
  await m.plugin.start();
  const item = m.makeItem(101, 'journalArticle', 'American Economic Review', [{ tag: '/unread', type: 1 }]);
  const observer = m.observers.get('observer');
  observer.notify('add', 'item', [101]);
  await m.plugin.drain();
  assert(item.tags.some(t => t.tag === '期刊星级/5'));
  item.fields.publicationTitle = 'Journal of Development Economics';
  observer.notify('modify', 'item', [101]);
  await m.plugin.drain();
  assert(item.tags.some(t => t.tag === '期刊星级/3'));
  assert(!item.tags.some(t => t.tag === '期刊星级/5'));
  item.fields.publicationTitle = '';
  observer.notify('modify', 'item', [101]);
  await m.plugin.drain();
  assert(item.tags.some(t => t.tag === '期刊星级/未评级'));
  item.fields.publicationTitle = 'The Quarterly Journal of Economics';
  observer.notify('modify', 'item', [101]);
  await m.plugin.drain();
  assert(item.tags.some(t => t.tag === '期刊星级/5'));
  assert.equal(m.columns.find(x => x.label === '期刊简称').dataProvider(item), 'QJE');
  assert(item.tags.some(t => t.tag === '/unread' && t.type === 1));
  const group = m.makeItem(102, 'journalArticle', 'American Economic Review', [], 2);
  const readOnly = m.makeItem(103, 'journalArticle', 'American Economic Review', [], 3);
  observer.notify('add', 'item', [102, 103]);
  await m.plugin.drain();
  assert.equal(group.saveCount, 0);
  assert.equal(readOnly.saveCount, 0);
  await m.plugin.stop();
  assert.deepEqual(m.errors, []);
});

test('cell rendering is text-only and missing journals do not display fake one-star scores', async () => {
  const m = mockRuntime(); await m.plugin.start();
  const doc = { createElement: () => ({ style: {}, setAttribute() {} }) };
  const stars = m.columns.find(x => x.label === '期刊星级');
  assert.equal(stars.renderCell(0, '5', {}, false, doc).textContent, '★★★★★');
  assert.equal(stars.renderCell(0, '1', {}, false, doc).textContent, '★☆☆☆☆');
  assert.equal(stars.renderCell(0, '0', {}, false, doc).textContent, '未评级');
  assert.equal(stars.renderCell(0, '-1', {}, false, doc).textContent, '');
  const short = m.columns.find(x => x.label === '期刊简称');
  assert.equal(short.renderCell(0, '<script>bad</script>', {}, false, doc).textContent, '<script>bad</script>');
  await m.plugin.stop();
});
