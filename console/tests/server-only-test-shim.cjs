const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function serverOnlyTestShim(request, parent, isMain) {
  if (request === "server-only") return {};
  return originalLoad.call(this, request, parent, isMain);
};
