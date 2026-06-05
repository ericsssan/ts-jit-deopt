'use strict';

const { derive, fromCorpus } = require('./mutate');
const { probe, SEV_LABEL }   = require('./probe');
const { fuzz }               = require('./fuzzer');

module.exports = { derive, fromCorpus, probe, fuzz, SEV_LABEL };
