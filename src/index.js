'use strict';

const { derive, fromCorpus }                          = require('./mutate');
const { probe, validateExport, isESMFile, SEV_LABEL } = require('./probe');
const { fuzz }                                        = require('./fuzzer');
const { bench }                                       = require('./bench');

module.exports = { derive, fromCorpus, probe, validateExport, isESMFile, fuzz, bench, SEV_LABEL };
