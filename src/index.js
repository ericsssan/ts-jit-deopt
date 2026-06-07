'use strict';

const { derive, fromCorpus }                          = require('./mutate');
const { probe, validateExport, isESMFile, SEV_LABEL } = require('./probe');
const { fuzz }                                        = require('./fuzzer');

module.exports = { derive, fromCorpus, probe, validateExport, isESMFile, fuzz, SEV_LABEL };
