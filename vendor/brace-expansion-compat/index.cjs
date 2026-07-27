"use strict";

const secure = require("brace-expansion-secure");
const expand = secure.expand;

function legacyExpand(pattern, options) {
  return expand(pattern, options);
}

module.exports = legacyExpand;
module.exports.expand = expand;
module.exports.EXPANSION_MAX = secure.EXPANSION_MAX;
module.exports.EXPANSION_MAX_LENGTH = secure.EXPANSION_MAX_LENGTH;
