#!/usr/bin/env node
'use strict';

const { cleanupAll, cleanupTestTmpRoot } = require('../test/tempRegistry.cjs');

cleanupAll();
cleanupTestTmpRoot();
console.log('Removed registered test artifacts and test_tmp/');
