const path = require("path");
const fs = require("fs");
const manager = require("./flows-file-manager");
const eol = require("eol");

/**
 * Here we define some types to allow the IDE to provide us autocompletion.
 * Some are documented directly by the nodered team but some are not.
 *
 * That's why we also made an `index.d.ts` for undocumented types we need to manipulate.
 * Those are defined by analysing the nodered code and some logging of those object.
 * In this regard, the types defined by ourselve might be incomplete.
 *
 * @typedef {import('./index').noderedEvent.FlowStartedEvent} FlowStartedEventType
 * @typedef {import('./index').noderedEvent.ExtendedNodeDef} ExtendedNodeDef
 * @typedef {import("node-red").NodeRedApp} REDType
 */

/**
 * Exposing the RED runtime globally to avoid passing it in every functions.
 * @type {REDType}
 */
let RED;

const CONFIG_FILE_NAME = ".config.flow-splitter.json";
const DEFAULT_CFG = {
  fileFormat: "yaml",
  destinationFolder: "src",
  tabsOrder: [],
  monolithFilename: "flows.json",
};

/**
 * @param {REDType} REDRuntime
 */
module.exports = function (REDRuntime) {
  RED = REDRuntime;

  // We register the pluggin for NodeRed
  RED.plugins.registerPlugin("flow-splitter", {
    type: "exotec-deploy-plugins",
    onadd: function () {
      RED.log.info("[flow-splitter] Initialized plugin successfully");
    },
  });

  // Code to launch on every restart of the flows = boot or deploy event
  RED.events.on("flows:started", onFlowReload);
};

/**
 * Main function. To be executed on each flow restart
 * @param {FlowStartedEventType} flowEventData
 * @returns {void}
 */
async function onFlowReload(flowEventData) {
  RED.log.info("[flow-splitter] Flow restart event");

  const projectPath = resolveProjectPath(path.join(RED.settings.userDir));

  RED.log.info("[flow-splitter] Fetching current splitter config");
  const cfg = loadSplitterConfig(projectPath);

  if (flowEventData.config.flows.length === 0) {
    // The flow file registered in the package.json does not exist or is empty.
    // Rebuild the flows from the split source files and push the resulting flow file to RED runtime.
    await rebuildFromSplitFiles(cfg, projectPath);
  } else {
    // Content in the reload of the flows has been found.
    // Split the flows into source files, overwrite the splitter config, and delete the monolithic flow file.
    await splitFromMonolith(flowEventData, cfg, projectPath);
  }
}

/**
 * Rebuilds the monolith flow file from split source files and triggers a Node-RED reload.
 * Called when Node-RED starts with an empty/missing flow file.
 * @param {object} cfg splitter config
 * @param {string} projectPath resolved project path
 */
async function rebuildFromSplitFiles(cfg, projectPath) {
  RED.log.info(
    "[flow-splitter] Rebuilding monolith file from splitter config and source files",
  );
  const flowSet = manager.constructFlowSetFromTreeFiles(cfg, projectPath);

  if (!flowSet) {
    RED.log.error(
      "[flow-splitter] Cannot build FlowSet from source tree files",
    );
    return;
  }

  const updatedCfg = manager.constructMonolithFileFromFlowSet(
    flowSet,
    cfg,
    projectPath,
    false,
  );
  writeSplitterConfig(updatedCfg, projectPath);

  RED.log.info("[flow-splitter] Stopping and loading nodes");
  const PRIVATE_RED = getPrivateRed();
  PRIVATE_RED.nodes.loadFlows(true).then(function () {
    RED.log.info("[flow-splitter] Flows are rebuilt and available");
  });
}

/**
 * Splits a monolith flow into source files and deletes the monolith.
 * Called when Node-RED starts with a populated flow file (deploy event).
 * @param {FlowStartedEventType} flowEventData
 * @param {object} cfg splitter config
 * @param {string} projectPath resolved project path
 */
async function splitFromMonolith(flowEventData, cfg, projectPath) {
  const flowSet = manager.constructFlowSetFromMonolithObject(
    flowEventData.config.flows,
  );
  const updatedCfg = manager.constructTreeFilesFromFlowSet(
    flowSet,
    cfg,
    projectPath,
  );
  writeSplitterConfig(updatedCfg, projectPath);

  // Node-RED may still be writing the flow file; retry a few times before giving up.
  const flowFilePath = path.join(projectPath, RED.settings.flowFile);
  let deleted = false;
  for (let attempt = 0; attempt < 5 && !deleted; attempt++) {
    await delay(100);
    try {
      fs.unlinkSync(flowFilePath);
      deleted = true;
    } catch (_) {}
  }
  if (!deleted) {
    RED.log.warn(
      `[flow-splitter] Cannot delete file '${RED.settings.flowFile}' after 5 attempts`,
    );
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A little trick to require the same "node-red" API to give private access to our own modulesContext.
 * (trick given in monogoto.io project)
 * @returns {REDType}
 */
function getPrivateRed() {
  for (const child of require.main.children) {
    if (child.filename.endsWith("red.js")) {
      return require(child.filename);
    }
  }
  return require("node-red");
}

/**
 * Resolves the active Node-RED project path.
 * Falls back to userDir when projects are not enabled.
 * @param {string} userDir
 * @returns {string}
 */
function resolveProjectPath(userDir) {
  const projectsCfgPath = path.join(userDir, ".config.projects.json");

  if (fs.existsSync(projectsCfgPath)) {
    const nrProjectsCfg = JSON.parse(fs.readFileSync(projectsCfgPath));
    return nrProjectsCfg.activeProject
      ? path.join(userDir, "projects", nrProjectsCfg.activeProject)
      : userDir;
  } else {
    return userDir;
  }
}

/**
 * Loads the splitter config for the given project.
 * Returns DEFAULT_CFG (merged with the current flowFile setting) when no config file exists.
 * @param {string} projectPath
 * @returns {object}
 */
function loadSplitterConfig(projectPath) {
  const cfgPath = path.join(projectPath, CONFIG_FILE_NAME);
  const base = { ...DEFAULT_CFG, monolithFilename: RED.settings.flowFile };

  if (fs.existsSync(cfgPath)) {
    const saved = JSON.parse(fs.readFileSync(cfgPath));
    return {
      ...base,
      ...saved,
      monolithFilename:
        saved.monolithFilename || RED.settings.flowFile || "flows.json",
    };
  } else {
    return base;
  }
}

function writeSplitterConfig(cfg, projectPath) {
  RED.log.info("[flow-splitter] Writing new config");
  try {
    const { monolithFilename, ...splitterCfgToWrite } = cfg;

    fs.writeFileSync(
      path.join(projectPath, CONFIG_FILE_NAME),
      eol.auto(JSON.stringify(splitterCfgToWrite, null, 2)),
    );
  } catch (error) {
    RED.log.warn(
      `[flow-splitter] Could not write splitter config '${CONFIG_FILE_NAME}': ${error}`,
    );
  }
}
