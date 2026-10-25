var JournalStarsRuntime;
var JournalStarsScope;

async function startup({ id, rootURI }) {
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  JournalStarsScope = { Zotero, Services, ChromeUtils };
  Services.scriptloader.loadSubScript(rootURI + "core.js", JournalStarsScope);
  Services.scriptloader.loadSubScript(rootURI + "plugin.js", JournalStarsScope);
  JournalStarsRuntime = new JournalStarsScope.JournalStarsPlugin(
    id, rootURI, JournalStarsScope.JournalRankCore);
  Zotero.DavidJournalStars = JournalStarsRuntime;
  await JournalStarsRuntime.start();
}
async function shutdown() {
  await JournalStarsRuntime?.stop();
  if (Zotero.DavidJournalStars === JournalStarsRuntime) delete Zotero.DavidJournalStars;
  JournalStarsRuntime = undefined;
  JournalStarsScope = undefined;
}
function install() {}
function uninstall() {}
async function onMainWindowLoad({ window }) {
  await JournalStarsRuntime?.addWindow(window);
}
function onMainWindowUnload({ window }) {
  JournalStarsRuntime?.removeWindow(window);
}
