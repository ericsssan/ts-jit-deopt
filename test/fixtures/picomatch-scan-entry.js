'use strict';
// Thin re-export so ic-fuzzer can watch picomatch/lib/scan.js directly.
const scan = require('picomatch/lib/scan');
function scanDirect(opts) {
  return scan(opts.pattern, opts);
}
module.exports = { scanDirect };
