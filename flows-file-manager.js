const flowParser = require("@node-red/flow-parser");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const eol = require("eol");

////////////////////////////////////////////////////////////
//  BASE FUNCTIONS
////////////////////////////////////////////////////////////

/**
 * Transform a string to a sanitized and safe string.
 * @param {string} stringElement string to normalize
 * @returns {string} normalized string
 */
function normalizeString(stringElement) {
  let normalized = stringElement
    .replace(/[^a-zA-Z0-9\.]/g, "-")
    .replace(/----/g, "-")
    .replace(/---/g, "-")
    .replace(/--/g, "-")
    .replace(/--/g, "-")
    .toLowerCase();
  if (normalized[0] === "-") {
    normalized = normalized.substring(1, normalized.length);
  }
  if (normalized[normalized.length - 1] === "-") {
    normalized = normalized.substring(0, normalized.length - 1);
  }
  return normalized;
}

/**
 * Elementary function to compare the id properties of 2 objects a and b
 * @param {object} a node object with 'id' property
 * @param {object} b node object with 'id' property
 * @returns {number}
 */
function compare(a, b) {
  if (a.id < b.id) {
    return -1;
  }
  if (a.id > b.id) {
    return 1;
  }
  return 0;
}

/**
 * Takes a flowSet as entry to create a 'normalizedLabel' in each node config of this flowSet.
 * @param {object} flowSet NRFlowSet defined in '@node-red/flow-parser'
 * @param {string} child first level child element of the flowSet should be from this enum : ['flows', 'subflows', 'configNodes']
 * @param {string} attribute attribute of the element to sanitize and store its result into x.config.normalizedLabel
 * @returns {object} disambiguated flowSet
 */
function disambiguate(flowSet, child, attribute) {
  flowSet.filenamesList = flowSet.filenamesList || [];
  flowSet[child].forEach((subelement) => {
    let normalizedAttribute = normalizeString(
      subelement.config[attribute] ||
        subelement[attribute] ||
        subelement.config.site?.name ||
        subelement.type ||
        subelement.id,
    );
    if (flowSet.filenamesList.includes(normalizedAttribute)) {
      normalizedAttribute += `-${subelement.id}`;
    }
    flowSet.filenamesList.push(normalizedAttribute);
    subelement.config.normalizedLabel = normalizedAttribute;
  });
  return flowSet;
}

/**
 * Takes an object an dumps it to the correct type given the extension parameter
 * @param {object} objectElement to be dumped
 * @param {string} extension JSON | YAML
 * @returns dumped data (JSON string or YAML dump)
 */
function forgeDumpData(objectElement, extension) {
  if (extension.toLowerCase() == "json") {
    return eol.auto(JSON.stringify(objectElement, null, 2));
  } else if (
    extension.toLowerCase() == "yaml" ||
    extension.toLowerCase() == "yml"
  ) {
    return yaml.dump(objectElement, { quotingType: '"' });
  }
  return;
}

/**
 * Ensure that the source directories for the split Tree Files exists
 * @param {object} config FlowsFileManager specific config object
 * @param {string} rootProjectPath path of your Node-RED project subject to the current manager
 * @returns {boolean} true if it succeeded, false otherwise
 */
function createSrcFolders(config, rootProjectPath) {
  var directories = [
    path.join(rootProjectPath || ".", config.destinationFolder, "tabs"),
    path.join(rootProjectPath || ".", config.destinationFolder, "subflows"),
    path.join(rootProjectPath || ".", config.destinationFolder, "config-nodes"),
  ];
  try {
    directories.forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  } catch (error) {
    console.log(`Creation of source directories failed : ${error}`);
    return false;
  } finally {
    return true;
  }
}

/**
 * Elementary function to move an element inside an array from its 'oldIndex' to the 'newIndex'
 * @param {Array} arr subject Array
 * @param {number} oldIndex
 * @param {number} newIndex
 * @returns arr
 */
function moveElementInArray(arr, oldIndex, newIndex) {
  if (newIndex >= arr.length) {
    var k = newIndex - arr.length + 1;
    while (k--) {
      arr.push(undefined);
    }
  }
  arr.splice(newIndex, 0, arr.splice(oldIndex, 1)[0]);
  return arr;
}

/**
 * Bubble up the flow nodes at the top of the array respecting the reference (should be a config.tabsOrder)
 * @param {object} flowConfig flows as a Javascript Object
 * @param {Array} reference Array reference to order by id (should be a config.tabsOrder)
 * @returns {object} flowConfig flows as a Javascript Object
 */
function reorderTabs(flowConfig, reference) {
  for (let i = reference.length - 1; i >= 0; i--) {
    const referenceId = reference[i];
    moveElementInArray(
      flowConfig,
      flowConfig.findIndex((x) => x.id === referenceId),
      0,
    );
  }
  return flowConfig;
}

/**
 * Fix the "group" node by removing their 'w' and 'h' properties and reordering the nodes array.
 * @param {object} contents
 * @returns contents
 */
function fixGroupNode(contents) {
  contents.forEach((element) => {
    element.content.forEach((node) => {
      if (node.type && node.type === "group") {
        if (node.w) {
          delete node.w;
        }
        if (node.h) {
          delete node.h;
        }
        if (node.nodes) {
          node.nodes = node.nodes.sort();
        }
      }
    });
  });

  return contents;
}

////////////////////////////////////////////////////////////
//  CORE FUNCTIONS
////////////////////////////////////////////////////////////

/**
 * Parses a generic monolith Node-RED JSON flows file into a usable flowSet
 * Calls internally constructFlowSetFromMonolithObject()
 * @param {string} filePath path to the JSON file
 * @returns {object} flowSet NRFlowSet defined in '@node-red/flow-parser'
 */
function constructFlowSetFromMonolithFile(filePath) {
  if (!fs.existsSync(path.join(filePath))) {
    console.log(`Failed to fetch ${filePath}`);
    return;
  }
  try {
    flowConfig = JSON.parse(fs.readFileSync(path.join(filePath)));
  } catch (error) {
    console.log(`Failed returning/parsing file : ${error}`);
    return;
  }
  return constructFlowSetFromMonolithObject(flowConfig);
}

/**
 * Parses a generic monolith Node-RED object into a usable flowSet
 * @param {object} flowConfig flows as a Javascript Object
 * @returns {object} flowSet NRFlowSet defined in '@node-red/flow-parser'
 */
function constructFlowSetFromMonolithObject(flowConfig) {
  const flowSet = flowParser.parseFlow(flowConfig);
  flowSet.tabsOrder = Array.from(flowSet.flows.keys());
  disambiguate(flowSet, "flows", "label");
  disambiguate(flowSet, "subflows", "name");
  disambiguate(flowSet, "configNodes", "name");

  return flowSet;
}

/**
 * Returns simple objects tabs, subflows, configNodes and arrays of their exported content
 * @param {object} flowSet NRFlowSet defined in '@node-red/flow-parser'
 * @param {object} config FlowsFileManager specific config object
 * @returns {object} Tree Object
 */
function constructTreeObjectFromFlowSet(flowSet) {
  let contents = [];

  // Append the flow (tabs) definitions
  flowSet.flows.forEach((flow) => {
    contents.push({
      fileName: flow.config.normalizedLabel,
      folder: "tabs",
      content: [flow.export()].concat(flow.exportContents().sort(compare)),
    });
  });
  // Append the subflow definitions
  flowSet.subflows.forEach((subflow) => {
    contents.push({
      fileName: subflow.config.normalizedLabel,
      folder: "subflows",
      content: [subflow.export()].concat(
        subflow.exportContents().sort(compare),
      ),
    });
  });
  // Append the configNodes definitions
  flowSet.configNodes.forEach((configNode) => {
    contents.push({
      fileName: configNode.config.normalizedLabel,
      folder: "config-nodes",
      content: [configNode.export()],
    });
  });

  contents = fixGroupNode(contents);

  return contents;
}

/**
 * Generate Tree Files structure and their files given a config and a flowSet and returns the config
 * @param {object} flowSet NRFlowSet defined in '@node-red/flow-parser'
 * @param {object} config FlowsFileManager specific config object
 * @param {string} rootProjectPath path of your Node-RED project subject to the current manager (default: current ".")
 * @returns {object} config FlowsFileManager specific config object
 */
function constructTreeFilesFromFlowSet(flowSet, config, rootProjectPath = ".") {
  // Check the config
  if (
    !config.fileFormat ||
    !config.destinationFolder ||
    !Object.keys(config).includes("tabsOrder") ||
    !config.monolithFilename
  ) {
    console.log(
      `Erroneous config file, missing key element in the JSON : ${config}`,
    );
    return;
  }
  if (!/^json|yaml|yml$/.test(config.fileFormat.toLowerCase())) {
    console.log(
      `Unexpected file format : ' ${config.fileFormat}'. Allowed formats are JSON and YAML.`,
    );
    return;
  }

  // Create the TreeObject from the flowSet for an easier loop to create the files
  const tree = constructTreeObjectFromFlowSet(flowSet);

  // Ensure that the destination folders and sub-folders all exist before creating the files
  if (createSrcFolders(config, rootProjectPath)) {
    // Then dump and write the files
    let data;
    tree.forEach((element) => {
      data = forgeDumpData(element.content, config.fileFormat.toLowerCase());
      try {
        fs.writeFileSync(
          path.join(
            rootProjectPath,
            config.destinationFolder,
            `./${element.folder}/`,
            `${element.fileName}.${config.fileFormat}`,
          ),
          data,
        );
      } catch (error) {
        console.log(
          `Could not create source files for element '${element.fileName}' : ${error}`,
        );
        return;
      }
    });
  }

  // Always return the config in a file creation method
  config.tabsOrder = flowSet.tabsOrder;
  return config;
}

/**
 * Generate a Monolith flowConfig
 * @param {object} flowSet NRFlowSet defined in '@node-red/flow-parser'
 * @param {object} config FlowsFileManager specific config object
 * @param {boolean} overwriteTabsOrder boolean to vaidate the overwriting of the config tabs order
 * @returns
 */
function constructMonolithObjectFromFlowSet(
  flowSet,
  config,
  overwriteTabsOrder = false,
) {
  if (
    !config.fileFormat ||
    !config.destinationFolder ||
    !Object.keys(config).includes("tabsOrder") ||
    !config.monolithFilename
  ) {
    console.log(
      `Erroneous config file, missing key element in the JSON : ${config}`,
    );
    return;
  }

  // Export the flowSet + sort all the nodes by their id
  let flowConfig = flowSet.export().sort(compare);

  if (config.tabsOrder.length > 0 && !overwriteTabsOrder) {
    // Bubble up the flow nodes at the top of the array respecting the 'tabsOrder' from the config
    return reorderTabs(flowConfig, config.tabsOrder);
  }

  return flowSet.export();
}

/**
 * Generate Monolith structure file given a config and a flowSet and returns the config
 * @param {object} flowSet NRFlowSet defined in '@node-red/flow-parser'
 * @param {object} config FlowsFileManager specific config object
 * @param {string} rootProjectPath path of your Node-RED project subject to the current manager (default: current ".")
 * @returns {object} config FlowsFileManager specific config object
 */
function constructMonolithFileFromFlowSet(
  flowSet,
  config,
  rootProjectPath = ".",
  overwriteTabsOrder = false,
) {
  const flowConfig = constructMonolithObjectFromFlowSet(
    flowSet,
    config,
    overwriteTabsOrder,
  );

  // Create the monolithFilename at the given rootProjectPath
  let data = forgeDumpData(flowConfig, "json");
  try {
    fs.writeFileSync(path.join(rootProjectPath, config.monolithFilename), data);
  } catch (error) {
    console.log(`Could not create ${config.monolithFilename} file : ${error}`);
    return;
  }

  if (overwriteTabsOrder) {
    config.tabsOrder = Array.from(flowSet.flows.keys());
  }

  // Always return the config in a file creation method
  return config;
}

/**
 * Generate a flow set from a tree object (internal type) and a config
 * @param {object} tree Tree Object
 * @param {object} config FlowsFileManager specific config object
 * @returns {object} flowSet NRFlowSet defined in '@node-red/flow-parser'
 */
function constructFlowSetFromTreeObject(tree, config) {
  let flowConfig = [];
  tree.forEach((element) => {
    flowConfig.concat(element.content);
  });
  return flowParser.parseFlow(reorderTabs(flowConfig, config.tabsOrder));
}

/**
 * Returns a flowSet given a config and a rootPath (it will Read and Parse the content of all files)
 * @param {object} config FlowsFileManager specific config object
 * @param {string} rootProjectPath path of your Node-RED project subject to the current manager (default: current ".")
 * @returns {object} flowSet NRFlowSet defined in '@node-red/flow-parser'
 */
function constructFlowSetFromTreeFiles(config, rootProjectPath) {
  // Check the config
  if (
    !config.fileFormat ||
    !config.destinationFolder ||
    !Object.keys(config).includes("tabsOrder") ||
    !config.monolithFilename
  ) {
    console.log(
      `Erroneous config file, missing key element in the JSON : ${config}`,
    );
    return;
  }
  if (!/^json|yaml|yml$/.test(config.fileFormat.toLowerCase())) {
    console.log(
      `Unexpected file format (it should be JSON or YAML exclusively) : ${config.fileFormat}`,
    );
    return;
  }
  if (
    !fs.existsSync(path.join(rootProjectPath || ".", config.destinationFolder))
  ) {
    console.log(
      `Disparity in config.destinationFolder '${config.destinationFolder}' and existing files.`,
    );
    return;
  }

  let flowConfig = [];

  ["tabs", "subflows", "config-nodes"].forEach((nodeType) => {
    fs.readdirSync(
      path.join(rootProjectPath || ".", config.destinationFolder, nodeType),
    ).forEach((filename) => {
      if (
        filename.substring(filename.length - config.fileFormat.length) !==
        config.fileFormat
      ) {
        console.log(
          `Unexpected file in the '${config.destinationFolder}' folder : ${filename}`,
        );
        return;
      }
      let treeFilePath = path.join(
        rootProjectPath || ".",
        config.destinationFolder,
        nodeType,
        filename,
      );
      if (!fs.existsSync(treeFilePath)) {
        console.log(`Can not locate '${filename}'.`);
        return;
      }
      let data = fs.readFileSync(treeFilePath);
      let flowObj = null;
      try {
        if (config.fileFormat.toLowerCase() == "json") {
          flowObj = JSON.parse(data);
        } else {
          flowObj = yaml.load(data);
        }
      } catch (error) {
        console.log(`Can not JSON/YAML parse '${filename}'`);
      }
      if (flowObj) {
        flowObj.forEach((node) => {
          flowConfig.push(node);
        });
      }
    });
  });
  return flowParser.parseFlow(reorderTabs(flowConfig, config.tabsOrder));
}

module.exports = {
  constructFlowSetFromMonolithFile,
  constructFlowSetFromMonolithObject,
  constructTreeFilesFromFlowSet,
  constructMonolithFileFromFlowSet,
  constructMonolithObjectFromFlowSet,
  constructFlowSetFromTreeObject,
  constructFlowSetFromTreeFiles,
};
