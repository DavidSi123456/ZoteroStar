/* Zotero 10 integration. All matching is local; no HTTP endpoints or PDF access. */
var JournalStarsPlugin = class {
  constructor(id, rootURI, core) {
    this.id = id;
    this.rootURI = rootURI;
    this.core = core;
    this.windows = new Set();
    this.pending = new Set();
    this.columnKeys = [];
    this.stopped = false;
    this.timer = null;
    this.work = null;
    this.updated = 0;
    this.errors = [];
    this.clock = Services.appShell.hiddenDOMWindow;
  }
  report(error) {
    this.errors.push(String(error));
    Zotero.logError(error);
  }
  type(item) { return Zotero.ItemTypes.getName(item.itemTypeID); }
  info(item) {
    const type = this.type(item);
    const title = type === "journalArticle" ? item.getField("publicationTitle")
      : type === "preprint" ? item.getField("repository") : "";
    return { type, title, rating: this.engine.rating(type, title) };
  }
  async start() {
    const text = await Zotero.File.getResourceAsync(this.rootURI + "rankings.json");
    this.dataset = JSON.parse(text);
    this.engine = this.core.createEngine(this.dataset);
    const plugin = this;
    const starKey = Zotero.ItemTreeManager.registerColumn({
      dataKey: "journalStars", label: "期刊星级", pluginID: this.id,
      enabledTreeIDs: ["main"], defaultIn: ["*"],
      width: "112", flex: 0, minWidth: 86, sortReverse: true,
      zoteroPersist: ["width", "ordinal", "hidden", "sortDirection"],
      dataProvider(item) {
        const { rating } = plugin.info(item);
        return rating.eligible ? String(rating.stars || 0) : "-1";
      },
      renderCell(index, data, column, first, doc) {
        const node = doc.createElement("span");
        node.className = "cell " + (column.className || "");
        const level = Number(data);
        node.textContent = level < 0 ? "" : level ? "★".repeat(level) + "☆".repeat(5 - level) : "未评级";
        node.style.fontVariantNumeric = "tabular-nums";
        node.style.letterSpacing = level > 0 ? "0.06em" : "normal";
        if (!level) node.style.opacity = "0.65";
        node.title = level > 0 ? `${level} 星 · AJG 2024 原等级 ${level === 5 ? "4*" : level}`
          : level === 0 ? "未收录、期刊信息缺失，或工作论文；不视为一星" : "";
        node.setAttribute("aria-label", level > 0 ? `${level}星期刊` : node.textContent);
        return node;
      }
    });
    const shortKey = Zotero.ItemTreeManager.registerColumn({
      dataKey: "journalShortName", label: "期刊简称", pluginID: this.id,
      enabledTreeIDs: ["main"], defaultIn: ["*"], width: "110", flex: 0, minWidth: 72,
      zoteroPersist: ["width", "ordinal", "hidden", "sortDirection"],
      dataProvider(item) {
        const { type, title } = plugin.info(item);
        let abbreviated = "";
        if (type === "journalArticle") abbreviated = item.getField("journalAbbreviation");
        return plugin.engine.abbreviation(type, title, abbreviated);
      },
      renderCell(index, data, column, first, doc) {
        const node = doc.createElement("span");
        node.className = "cell " + (column.className || "");
        node.textContent = data;
        node.title = data;
        return node;
      }
    });
    if (!starKey || !shortKey) throw new Error("期刊星级插件未能注册列表列");
    this.columnKeys = [shortKey, starKey];
    this.observerID = Zotero.Notifier.registerObserver({
      notify(event, type, ids) {
        if (!plugin.stopped && type === "item" && ["add", "modify"].includes(event)) {
          plugin.enqueue(ids);
        }
      }
    }, ["item"], "journal-stars");
    for (const win of Zotero.getMainWindows()) await this.addWindow(win);
    await this.ensureSearches();
    await this.reindex();
    Zotero.ItemTreeManager.refreshColumns();
  }
  userLibraries() {
    return Zotero.Libraries.getAll().filter(lib => lib.libraryType === "user" && lib.editable);
  }
  async ensureSearches() {
    for (const library of this.userLibraries()) {
      const searches = await Zotero.Searches.getAll(library.libraryID);
      const labels = { 5: "① ★★★★★", 4: "② ★★★★", 3: "③ ★★★", 2: "④ ★★", 1: "⑤ ★", 0: "⑥ 未评级" };
      for (const level of [5, 4, 3, 2, 1, 0]) {
        const name = "期刊评级 " + labels[level];
        let search = searches.find(s => s.name === name);
        const desired = this.core.tagForLevel(level);
        if (search) {
          await search.loadDataType("conditions");
          const json = await search.toJSON();
          const conditions = json.conditions || [];
          const owned = conditions.some(c => c.condition === "tag" && this.core.ownedTag(c.value));
          // A similarly named user search with unrelated conditions is not overwritten.
          if (!owned) continue;
          let changed = false;
          for (const c of conditions) {
            if (c.condition === "tag" && this.core.ownedTag(c.value) && c.value !== desired) {
              c.value = desired; changed = true;
            }
          }
          if (!changed) continue;
          await search.fromJSON({ name, conditions });
        } else {
          search = new Zotero.Search();
          search.libraryID = library.libraryID;
          search.name = name;
          search.addCondition("tag", "is", desired);
          search.addCondition("noChildren", "true");
        }
        await search.saveTx();
      }
    }
  }
  enqueue(ids) {
    if (this.stopped) return;
    for (const id of ids) if (Number.isInteger(Number(id))) this.pending.add(Number(id));
    if (!this.timer && !this.work) {
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        this.drain().catch(error => this.report(error));
      }, 200);
    }
  }
  async reindex() {
    for (const library of this.userLibraries()) {
      const items = await Zotero.Items.getAll(library.libraryID, true, false);
      this.enqueue(items.filter(item => item.isRegularItem()).map(item => item.id));
    }
    return this.drain();
  }
  async drain() {
    if (this.work) return this.work;
    if (this.stopped) return;
    if (this.timer) { this.clock.clearTimeout(this.timer); this.timer = null; }
    this.work = this.processQueue();
    try { await this.work; }
    finally {
      this.work = null;
      if (this.pending.size && !this.stopped) this.enqueue([]);
    }
  }
  async processQueue() {
    while (this.pending.size && !this.stopped) {
      const ids = [...this.pending].slice(0, 35);
      ids.forEach(id => this.pending.delete(id));
      const updates = [];
      for (const id of ids) {
        try {
          const item = await Zotero.Items.getAsync(id);
          if (!item || item.deleted || !item.isRegularItem()) continue;
          const library = Zotero.Libraries.get(item.libraryID);
          if (library?.libraryType !== "user" || !library.editable) continue;
          await item.loadDataType("itemData");
          await item.loadDataType("tags");
          const { type, title } = this.info(item);
          const old = item.getTags();
          const desired = this.engine.desiredTags(type, title, old);
          if (!this.core.equalTags(old, desired)) updates.push({ item, desired });
        } catch (error) { this.report(error); }
      }
      if (!updates.length) continue;
      await Zotero.DB.executeTransaction(async () => {
        for (const { item, desired } of updates) {
          if (this.stopped) break;
          item.setTags(desired);
          await item.save({ skipDateModifiedUpdate: true });
          this.updated++;
        }
      });
      await Zotero.Promise.delay(0);
    }
  }
  async addWindow(win) {
    if (this.stopped || this.windows.has(win)) return;
    const doc = win.document;
    const toolbar = doc.getElementById("zotero-items-toolbar");
    if (!toolbar) return;
    this.windows.add(win);
    const button = doc.createXULElement("toolbarbutton");
    button.id = "journal-stars-filter";
    button.setAttribute("label", "期刊星级");
    button.setAttribute("type", "menu");
    button.setAttribute("class", "zotero-tb-button");
    button.setAttribute("tooltiptext", "按星级筛选当前分类；AJG 2024。新导入文章自动匹配。");
    button.style.marginInline = "6px";
    const popup = doc.createXULElement("menupopup");
    button.appendChild(popup);
    const entries = [["all", "全部（清除星级筛选）"], ["5", "★★★★★"], ["4", "★★★★"],
      ["3", "★★★"], ["2", "★★"], ["1", "★"], ["0", "未评级"]];
    for (const [level, label] of entries) {
      const menu = doc.createXULElement("menuitem");
      menu.setAttribute("label", label);
      menu.setAttribute("type", "radio");
      menu.setAttribute("name", "journal-stars-level");
      menu.dataset.level = level;
      menu.addEventListener("command", () => this.applyFilter(win, level).catch(error => this.report(error)));
      popup.appendChild(menu);
    }
    popup.addEventListener("popupshowing", () => {
      const selected = win.ZoteroPane.tagSelector?.selectedTags || new Set();
      let level = "all";
      for (const tag of selected) if (this.core.isRatingTag(tag)) level = tag.endsWith("未评级") ? "0" : tag.slice(-1);
      for (const node of popup.children) {
        if (node.dataset.level) node.setAttribute("checked", String(node.dataset.level === level));
      }
    });
    popup.appendChild(doc.createXULElement("menuseparator"));
    const reindex = doc.createXULElement("menuitem");
    reindex.setAttribute("label", "重新匹配全部文献");
    reindex.addEventListener("command", () => this.reindex().catch(error => this.report(error)));
    popup.appendChild(reindex);
    const about = doc.createXULElement("menuitem");
    about.setAttribute("label", "评级依据与说明");
    about.addEventListener("command", () => Services.prompt.alert(win, "期刊星级与简称", [
      "评级来源：CABS Academic Journal Guide 2024（1822 本期刊）。",
      "4* → ★★★★★；4/3/2/1 → 四/三/二/一星。未收录不视为一星。",
      "期刊层级不能替代对论文内容的评价。",
      "简称优先采用常见约定（如 AER、QJE、JDE），其次使用题录中的期刊简称，最后显示原刊名。",
      "导入或修改期刊信息后自动更新。全部匹配均在本机进行，不读取 PDF，不发送网络请求。"
    ].join("\n\n")));
    popup.appendChild(about);
    const anchor = doc.getElementById("zotero-tb-search-spinner") || doc.getElementById("zotero-tb-search");
    toolbar.insertBefore(button, anchor || null);
    try { await this.configureColumns(win); }
    catch (error) { this.report(error); }
  }
  async configureColumns(win) {
    const pane = win.ZoteroPane;
    if (!pane?.itemsView) return;
    const view = pane.itemsView;
    if (Zotero.Prefs.get("extensions.journalStars.columnsConfigured", true)) return;
    const prefs = { ...view._getColumnPrefs() };
    const all = view.getColumns();
    const other = all.filter(col => !this.columnKeys.includes(col.dataKey))
      .sort((a, b) => (prefs[a.dataKey]?.ordinal ?? all.indexOf(a)) - (prefs[b.dataKey]?.ordinal ?? all.indexOf(b)));
    const ordered = other.map(col => col.dataKey);
    const title = ordered.indexOf("title");
    ordered.splice(title < 0 ? 0 : title + 1, 0, ...this.columnKeys);
    ordered.forEach((key, index) => {
      prefs[key] = { ...prefs[key], ordinal: index };
      if (this.columnKeys.includes(key)) Object.assign(prefs[key], { hidden: false, width: 112 });
    });
    view._storeColumnPrefs(prefs);
    await view._resetColumns();
    Zotero.Prefs.set("extensions.journalStars.columnsConfigured", true, true);
  }
  async applyFilter(win, level) {
    await this.drain();
    const pane = win.ZoteroPane;
    const selector = pane.tagSelector;
    const selected = this.core.filterTags(selector?.selectedTags || [], level);
    if (selector) { selector.selectedTags = selected; selector.forceUpdate(); }
    await pane.itemsView.setFilter("tags", selected);
  }
  removeWindow(win) {
    win.document.getElementById("journal-stars-filter")?.remove();
    this.windows.delete(win);
  }
  async stop() {
    this.stopped = true;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.pending.clear();
    if (this.observerID) Zotero.Notifier.unregisterObserver(this.observerID);
    if (this.work) await this.work;
    for (const win of [...this.windows]) this.removeWindow(win);
    for (const key of this.columnKeys) Zotero.ItemTreeManager.unregisterColumn(key);
  }
};
if (typeof module !== "undefined") module.exports = JournalStarsPlugin;
