'use strict';

// Minimal hot-path function used by probe.test.js.
// Same structure as the article's handleEvent — purely exercises property reads.
function compute(event) {
  return event.id * 31 + event.value;
}

module.exports = { compute };
